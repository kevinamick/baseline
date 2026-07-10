"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { requireContributor } from "@/lib/auth/require-contributor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { getTemporalClient } from "@/lib/temporal/client";
import {
  OPTIMIZATION_RETRY_NOW_SIGNAL,
  OPTIMIZATION_TASK_QUEUE,
} from "@/lib/temporal/connection";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";
import { firstIssueMessage } from "@/lib/validation/first-issue";
import {
  DEFAULT_SIMPLE_REFLECT_MODEL,
  providerForReflectModel,
  PROVIDER_DEFAULT_JUDGE_MODEL,
} from "@/lib/optimization/models";
import { insertConnection } from "@/lib/connections/create";
import { snapshotDatasetInstances } from "@/lib/optimization/dataset-snapshot";
import { resolveEvalRunInstances } from "@/lib/optimization/eval-run-instances";
import { minimumViableBudget } from "@/lib/optimization/budget";
import {
  getOptimizationAllowance,
  settleOptimizationRunUnit,
  settleOptimizationRunPoints,
} from "@/lib/billing/allowance";
import { evalRunPointsPerRow, optimizationRunPointCost } from "@/lib/billing/points";
import {
  checkRunPreflight,
  reserveRunOrRefuse,
  localizeRunGateError,
  RUN_KIND,
  KEY_MODE_STRATEGY,
  type ManagedSpendTerm,
} from "@/lib/billing/run-gate";
import {
  ESTIMATE_JUDGE_MODEL,
  ESTIMATE_JUDGE_PROVIDER,
  ESTIMATE_REFLECT_MODEL,
} from "@/lib/llm/model-prices";
import {
  ACTIVE_OPTIMIZATION_STATUSES,
  isActiveOptimizationStatus,
  type OptimizationRunStatus,
  type OptimizationRunSummary,
} from "@/types/optimization";

// ---------- Start ----------

// Start a manual, one-shot Optimization Run (#87). Authz (Contributor), resolve the instance
// set (inline rows, a dataset-Connection snapshot, #82, or an existing Eval Run's rows, #83)
// into a frozen set, enforce one active run per org, then start the durable Temporal workflow.
// Per ADR-0006 the workflow carries only the run id — Activities read the prompts/instances and
// write rollouts/results back to Postgres.
export async function startOptimizationRun(
  input: z.input<typeof CreateOptimizationRunSchema>
): Promise<{ optRunId: string } | { error: string }> {
  const gate = await requireContributor("start optimization runs");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;

  const parsed = CreateOptimizationRunSchema.safeParse(input);
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Invalid optimization run") };
  }
  const o = parsed.data;

  // Resolve the run's frozen instance set FIRST (#82, #83) — before any Run Gate call and before
  // the run row exists. 'inline' is a no-op (the wizard already resolved manual/CSV/JSON rows
  // client-side). 'dataset_snapshot' does the ONE fetch here: an org-scoped Connection lookup,
  // its credential decrypt, then a bounded adapter read over the chosen window. 'eval_run' does
  // an org-scoped read of an existing Eval Run's rows (#83), capped/ordered/agent_output-dropped
  // by resolveEvalRunInstances. Either way billing (which prices off instances.length), freezing
  // into optimization_inputs, and validation are byte-for-byte identical to the inline source,
  // and the worker needs no changes at all. An empty result or an unresolvable source (unreachable
  // Connection, unknown/foreign eval_run_id, a source with zero rows) refuses cleanly right here:
  // nothing has been created yet, so there is no run row or reservation to roll back.
  let instances: {
    userInput: string;
    expectedOutput?: string | null;
    retrievalContext?: string | null;
  }[];
  if (o.instancesSource.type === "inline") {
    instances = o.instancesSource.instances;
  } else if (o.instancesSource.type === "eval_run") {
    const resolved = await resolveEvalRunInstances(orgId, o.instancesSource.evalRunId);
    if ("error" in resolved) {
      return {
        error:
          resolved.error === "not_found"
            ? "Eval run not found"
            : "That eval run has no rows to seed instances from — pick another eval run.",
      };
    }
    instances = resolved.instances;
  } else {
    const { connectionId: datasetConnectionId, windowMinutes } = o.instancesSource;
    const { data: dsConn, error: dsConnErr } = await tenantDb(ctx)
      .from("connections")
      .select(
        "id",
        "kind",
        "provider",
        "endpoint",
        "auth_header",
        "auth_secret_id",
        "request_template",
        "response_path",
        "config"
      )
      .eq("id", datasetConnectionId)
      .maybeSingle();
    if (dsConnErr) throw dsConnErr;
    if (!dsConn) return { error: "Dataset connection not found" };
    if (dsConn.kind !== "dataset") {
      return { error: "Select a dataset connection to snapshot instances from" };
    }

    // Decrypt the Connection's credential (full header value), mirroring the worker's own
    // getAuthValue (worker/src/evalrun/activities.ts) — same RPC, same service-role grant.
    let authValue: string | null = null;
    if (dsConn.auth_secret_id) {
      const { data: secret, error: secretErr } = await supabaseAdmin.rpc("get_connection_auth", {
        p_secret_id: dsConn.auth_secret_id,
      });
      if (secretErr) {
        await log.error("dataset instance snapshot credential read failed", {
          event: "optimization_run.dataset_snapshot_credential_failed",
          org_id: orgId,
          connection_id: dsConn.id,
          error: secretErr,
        });
        return { error: "Couldn't read that Connection's credential. Please try again." };
      }
      authValue = (secret as string | null) ?? null;
    }

    const snapshot = await snapshotDatasetInstances(
      {
        id: dsConn.id,
        kind: dsConn.kind,
        provider: dsConn.provider,
        endpoint: dsConn.endpoint,
        auth_header: dsConn.auth_header,
        auth_secret_id: dsConn.auth_secret_id,
        request_template: dsConn.request_template,
        response_path: dsConn.response_path,
        config: dsConn.config,
      },
      authValue,
      windowMinutes
    );
    if ("error" in snapshot) {
      const failure = {
        event: "optimization_run.dataset_snapshot_failed",
        org_id: orgId,
        connection_id: dsConn.id,
        error_code: snapshot.error,
        detail: snapshot.detail,
      };
      // Mirrors previewDatasetConnection's escalation: an "endpoint" refusal is the SSRF/egress
      // signal, worth surfacing distinctly from ordinary source misconfiguration.
      if (snapshot.error === "endpoint") {
        await log.error("dataset instance snapshot blocked or unreachable", failure);
      } else {
        await log.warn("dataset instance snapshot failed", failure);
      }
      return { error: "Couldn't fetch rows from that Connection. Please try again." };
    }
    if (snapshot.instances.length === 0) {
      return {
        error:
          "That Connection had no rows in the selected window — pick a wider window or another source.",
      };
    }
    instances = snapshot.instances;
  }

  // Budget floor (#468, prod incident opt-4afa3642): refuse right here, before any Connection or
  // allowance work, a run whose budget can't survive its own seed baseline (a full pass over the
  // now-exact frozen instance set) plus at least one iteration — every budget smaller than the
  // instance count burns the whole budget scoring the seed, the iteration guard then refuses to
  // start iteration 1, and the run "completes" with best = seed and zero lift. instances.length is
  // exact for every source at this point (inline, dataset snapshot, eval run), so this is a hard
  // check, not an estimate. Mode-aware — see src/lib/optimization/budget.ts for why Reflective and
  // Simple Mode have different minimums.
  const minViableBudget = minimumViableBudget(o.mode, instances.length);
  if (o.budgetRollouts < minViableBudget) {
    return {
      error: `${instances.length} instances need a rollout budget of at least ${minViableBudget} (one full pass to score the seed, plus one iteration) — increase the budget or use fewer instances.`,
    };
  }

  // Run Gate (#377/#382): seat cap, checked here (before any Connection is
  // created) exactly as before. The BYO-key gate and the managed-payment gate
  // aren't reachable yet — the payment gate needs the run's provider(s), which
  // aren't known until the Connection below resolves — so this call declares
  // neither (requireProviderKeyForFreePlan: false, no payment-check providers)
  // and a second checkRunPreflight call below covers the payment gate once the
  // provider(s) are known. Two calls into the same cheap, side-effect-free
  // preflight preserve the original refusal ORDER (seat cap before Connection
  // resolution, payment gate after) without reshaping the gate around a
  // Connection dependency it shouldn't have.
  const seatPreflight = await checkRunPreflight({
    runKind: RUN_KIND.optimization,
    orgId,
    requireProviderKeyForFreePlan: false,
    managedPaymentCheckProviders: [],
  });
  if (!seatPreflight.ok) {
    return { error: await localizeRunGateError(seatPreflight.refusal) };
  }

  // Allowance gates (#181, ADR-0008). These pre-checks fail fast — before any
  // Connection is created — but the atomic reserve below remains authoritative.
  const allowance = await getOptimizationAllowance(orgId);
  if (allowance.included === 0) {
    // Free Teams: a gated state, not a quota error — there is nothing to use up.
    return {
      error:
        "Optimization Runs aren't included on the Free plan. Upgrade to run prompt optimization.",
    };
  }
  if (o.budgetRollouts > allowance.maxBudgetRollouts) {
    // The wizard caps its input at the plan ceiling; be authoritative anyway.
    return {
      error: `Rollout budget can't exceed ${allowance.maxBudgetRollouts} on the ${allowance.plan} plan.`,
    };
  }

  // Verify the rubric belongs to the team. criteria count feeds the managed
  // pre-run estimate (#185).
  const { data: rubric, error: rubricErr } = await tenantDb(ctx)
    .from("rubrics")
    .select("id", "criteria")
    .eq("id", o.rubricId)
    .maybeSingle();
  if (rubricErr) throw rubricErr;
  if (!rubric) return { error: "Rubric not found" };
  const criteriaCount = Array.isArray(rubric.criteria) ? rubric.criteria.length : 0;

  // Resolve the agent Connection: an existing one (verify ownership + agent kind) or create one
  // inline from the wizard's System step (#108). A Connection created here is rolled back if the
  // run can't be started, so a failed start never leaves an orphan Connection behind.
  let connectionId: string;
  let createdConnectionId: string | null = null;
  // The Managed Agent's target model, if this run's System runs on the managed key (#291). Read
  // here off the authoritative ownership query so the spend estimate below has it without a second
  // round-trip — and with no separate read that could fail silently and drop the dominant term.
  let targetModel: string | null = null;
  if (o.newConnection) {
    const created = await insertConnection(orgId, userId, o.newConnection);
    if ("error" in created) return { error: created.error };
    connectionId = created.connectionId;
    createdConnectionId = created.connectionId;
    // The "Paste a prompt" mode (#293) inline-creates a Managed Agent: carry its target model
    // so the spend estimate below reserves the target-model term, exactly as the existing-managed
    // path does. The external "Connect your agent" mode leaves targetModel null.
    if (o.newConnection.type === "managed_agent") targetModel = o.newConnection.targetModel;
  } else if (o.connectionId) {
    // Only agents expose the {{prompt:*}} Modules an optimization run tunes.
    const { data: connection, error: connErr } = await tenantDb(ctx)
      .from("connections")
      .select("id", "kind", "optimizable_prompts", "agent_kind", "target_model")
      .eq("id", o.connectionId)
      .maybeSingle();
    if (connErr) throw connErr;
    if (!connection) return { error: "Connection not found" };
    if (connection.kind !== "agent") {
      return { error: "Optimization requires an agent connection" };
    }
    // The wizard hides Module-less connections, but be authoritative here too: with no Modules
    // there's nothing to tune — the loop would no-op on the seed and waste a rollout. (A
    // connection's Modules can also be removed after the list was rendered.)
    const moduleCount = Array.isArray(connection.optimizable_prompts)
      ? connection.optimizable_prompts.length
      : 0;
    if (moduleCount === 0) {
      return {
        error: "This agent connection has no optimizable Modules — add at least one to optimize it.",
      };
    }
    connectionId = connection.id;
    if (connection.agent_kind === "managed") targetModel = connection.target_model;
  } else {
    return { error: "Select or create an agent connection" };
  }

  const cleanupCreatedConnection = async () => {
    if (createdConnectionId) {
      await tenantDb(ctx).from("connections").delete().eq("id", createdConnectionId);
    }
  };

  // Simple Mode (ADR-0015) is gated to a paste-a-prompt Managed Agent: it's always single-Module
  // and runs on the managed key, which is what its score-only search assumes. targetModel is set
  // iff the System is a Managed Agent, so it doubles as the managed-ness check. Reject any other
  // System before reserving allowance, rolling back an inline-created Connection.
  const isManagedAgent = targetModel != null;
  if (o.mode === "simple" && !isManagedAgent) {
    await cleanupCreatedConnection();
    return { error: "Simple mode is only available for a paste-a-prompt Managed Agent." };
  }

  // Simple Mode reuses reflect_model as its generation model but defaults it to Haiku (not the
  // column's Sonnet default); an explicit override from the wizard still wins. Reflective runs
  // keep the column default when no override is given.
  const reflectModel =
    o.reflectModel ?? (o.mode === "simple" ? DEFAULT_SIMPLE_REFLECT_MODEL : null);

  // Resolve the run's provider before the allowance reserve: a run is single-provider, so the
  // payment gate and the spend estimate must both check the provider that will actually be metered
  // (not a hardcoded Anthropic default, which would mis-gate non-Anthropic managed runs, #204).
  const runProvider = providerForReflectModel(reflectModel ?? ESTIMATE_REFLECT_MODEL);

  // Run Gate (#377/#382): the managed-payment fail-closed gate (#186), now that
  // the run's provider(s) are known. Declared for the reflect provider AND the
  // Managed Agent target provider independently (#204): a run judging on a BYO
  // reflect key can still drive a managed target, so a target-provider payment
  // failure must block it too — mirroring the per-provider managed-spend
  // reserve below.
  const targetProvider = targetModel ? providerForReflectModel(targetModel) : null;
  const paymentPreflight = await checkRunPreflight({
    runKind: RUN_KIND.optimization,
    orgId,
    requireProviderKeyForFreePlan: false,
    managedPaymentCheckProviders: targetProvider ? [runProvider, targetProvider] : [runProvider],
  });
  if (!paymentPreflight.ok) {
    await cleanupCreatedConnection();
    return { error: await localizeRunGateError(paymentPreflight.refusal) };
  }

  // Insert the run as queued. The partial unique index (one active run per org) rejects a
  // concurrent second start with a 23505 — surface that as a friendly message.
  const { data: run, error: runErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .insert({
      created_by: userId,
      connection_id: connectionId,
      rubric_id: o.rubricId,
      eval_type: o.evalType,
      budget_rollouts: o.budgetRollouts,
      max_iters: o.maxIters,
      plateau_patience: o.plateauPatience ?? null,
      mode: o.mode,
      ...(reflectModel ? { reflect_model: reflectModel } : {}),
      status: "queued",
    })
    .select("id")
    .single();

  if (runErr || !run) {
    await cleanupCreatedConnection();
    if (runErr?.code === "23505") {
      return { error: "An optimization run is already active for this team" };
    }
    await log.error("optimization_runs insert failed", {
      event: "optimization_run.create_failed",
      org_id: orgId,
      error: runErr,
    });
    return { error: "Failed to start optimization run" };
  }

  // Worst-case point cost, needed regardless of which meter this run draws
  // from: the "points" branch reserves it exactly, the "unit" branch's Managed
  // Spend Cap term estimate below doesn't depend on it but the gate needs SOME
  // spec either way (ADR-0016's dual meter).
  const drawsPoints = allowance.remaining < 1;
  const perRolloutCost = evalRunPointsPerRow(criteriaCount);
  const worstCasePoints = optimizationRunPointCost(o.budgetRollouts, criteriaCount);

  // Run Gate (#377/#382) callbacks. `deleteRun` fires when NOTHING was reserved
  // yet (allowance/points refusal); `rollbackReservations` settles both meters
  // (a 'skipped' settle is a no-op for whichever this run didn't touch) before
  // deleting the row — settle must land BEFORE the delete (it nulls the ledger
  // FKs, after which the reservations are unfindable). If a settle fails, LEAVE
  // the run row: the reaper fails-and-settles queued runs with no workflow
  // within ~1 minute — a briefly-held active slot beats a reservation stranded
  // for the whole period. Both callbacks always clean up an inline-created
  // Connection too, mirroring every refusal path before this port.
  const deleteRun = async () => {
    await tenantDb(ctx).from("optimization_runs").delete().eq("id", run.id);
    await cleanupCreatedConnection();
  };
  const rollbackReservations = async () => {
    const unit = await settleOptimizationRunUnit(run.id);
    const pts = await settleOptimizationRunPoints(run.id, "skipped");
    if (unit.error || pts.error) {
      await log.error("allowance release failed — leaving the run for the reaper to settle", {
        event: "optimization_run.allowance_release_failed",
        opt_run_id: run.id,
        org_id: orgId,
        error: unit.error ?? pts.error,
      });
    } else {
      await tenantDb(ctx).from("optimization_runs").delete().eq("id", run.id);
    }
    await cleanupCreatedConnection();
  };

  // Run Gate (#377/#382): reserve the run's allowance-unit-or-Eval-Point cost
  // (ADR-0016's dual meter — WITHIN the included run-count draws one allowance
  // unit and zero points; PAST it meters worst-case Eval Points instead of
  // hard-blocking), then — only for whichever leg(s) resolve to the managed
  // key — the estimated Managed Spend Cap term(s): judge + reflect on the run's
  // reflect/generation provider, and (#204/#291) a Managed Agent's target
  // inference on its OWN provider independently, since that's the dominant
  // spend term and must be reserved even when the reflect side is BYO. The
  // run's judge model is its provider's fast model (the worker's
  // defaultJudgeModelForProvider, mirrored by PROVIDER_DEFAULT_JUDGE_MODEL);
  // Anthropic keeps the ESTIMATE_JUDGE_MODEL constant (pinned to the worker's
  // DEFAULT_JUDGE_MODEL by the parity test). The prompt-proposer term: GEPA
  // reflects once per iteration (max_iters calls); Simple Mode generates one
  // rewrite per Candidate, coarsely bounded by budget_rollouts.
  //
  // budget_rollouts is denominated in INSTANCE-INVOCATIONS — the workflow
  // charges rolloutsUsed += instancesRun against it, and the Eval-Point
  // reserve prices it as budget × points-per-row. So the judge/target volume
  // is the budget itself; multiplying by instance count again would treat the
  // budget as full-set candidate evaluations and inflate the reserve by the
  // dataset size (the prod incident reserved $13.52 for a run whose true
  // worst case was ~$0.59).
  const runJudgeModel =
    runProvider === ESTIMATE_JUDGE_PROVIDER ? ESTIMATE_JUDGE_MODEL : PROVIDER_DEFAULT_JUDGE_MODEL[runProvider];
  const proposerCalls = o.mode === "simple" ? o.budgetRollouts : o.maxIters;
  const managedSpendTerms: ManagedSpendTerm[] = [
    {
      keyModeStrategy: KEY_MODE_STRATEGY.perProvider,
      provider: runProvider,
      model: runJudgeModel,
      volume: o.budgetRollouts,
      criteriaCount,
    },
    {
      keyModeStrategy: KEY_MODE_STRATEGY.perProvider,
      provider: runProvider,
      model: reflectModel ?? ESTIMATE_REFLECT_MODEL,
      volume: proposerCalls,
      criteriaCount: 1,
    },
    ...(targetModel && targetProvider
      ? [
          {
            keyModeStrategy: KEY_MODE_STRATEGY.perProvider,
            provider: targetProvider,
            model: targetModel,
            volume: o.budgetRollouts,
            criteriaCount: 1,
          } satisfies ManagedSpendTerm,
        ]
      : []),
  ];

  const reserved = await reserveRunOrRefuse({
    runKind: RUN_KIND.optimization,
    orgId,
    userId,
    runId: run.id,
    pointReserve: drawsPoints
      ? {
          kind: "optimization_points",
          pointCost: worstCasePoints,
          included: allowance.included,
          metadata: {
            criteria_count: criteriaCount,
            budget_rollouts: o.budgetRollouts,
            per_rollout_cost: perRolloutCost,
          },
        }
      : {
          kind: "optimization_unit",
          period: {
            periodStart: allowance.periodStart,
            periodEnd: allowance.periodEnd,
            included: allowance.included,
            plan: allowance.plan,
          },
        },
    managedSpendTerms,
    managedSpendRef: { optRunId: run.id },
    callbacks: { deleteRun, rollbackReservations },
  });
  if (!reserved.ok) {
    return { error: await localizeRunGateError(reserved.refusal) };
  }

  // Freeze the manually provided instances. On failure, delete the run row so the org isn't
  // left with a stuck active run blocking future starts (and frees the partial-unique slot),
  // and roll back any inline-created Connection.
  const { error: inputsErr } = await supabaseAdmin.from("optimization_inputs").insert(
    instances.map((row, i) => ({
      opt_run_id: run.id,
      instance_index: i,
      user_input: row.userInput,
      expected_output: row.expectedOutput ?? null,
      retrieval_context: row.retrievalContext ?? null,
    }))
  );
  if (inputsErr) {
    await log.error("optimization_inputs insert failed", {
      event: "optimization_run.inputs_insert_failed",
      opt_run_id: run.id,
      error: inputsErr,
    });
    await rollbackReservations();
    return { error: "Failed to save the input set" };
  }

  // Start the durable workflow by string name — workflow code must never enter the Next
  // bundle (it runs only inside the Temporal worker's sandbox).
  const workflowId = `opt-${run.id}`;
  try {
    const client = await getTemporalClient();
    // Dispatch by Mode (ADR-0015): Simple runs the Monte Carlo workflow, everything else GEPA.
    // Both share the task queue and carry only the run id.
    const workflowName =
      o.mode === "simple" ? "runSimpleOptimizationWorkflow" : "runOptimizationWorkflow";
    await client.workflow.start(workflowName, {
      taskQueue: OPTIMIZATION_TASK_QUEUE,
      workflowId,
      args: [{ optRunId: run.id }],
    });
  } catch (err) {
    await log.error("Failed to start optimization workflow", {
      event: "optimization_run.workflow_start_failed",
      opt_run_id: run.id,
      workflow_id: workflowId,
      error: err,
    });
    await rollbackReservations();
    return { error: "Failed to start optimization run" };
  }

  await tenantDb(ctx)
    .from("optimization_runs")
    .update({ workflow_id: workflowId })
    .eq("id", run.id);

  await log.info("optimization workflow started", {
    event: "optimization_run.workflow_started",
    opt_run_id: run.id,
    workflow_id: workflowId,
    org_id: orgId,
  });

  await track(
    {
      name: "optimization_run.started",
      props: { instance_count: instances.length, budget: o.budgetRollouts },
    },
    { userId }
  );

  revalidatePath("/optimizations");
  return { optRunId: run.id };
}

// ---------- Cancel ----------

// Cancel an active Optimization Run (#109): terminate its Temporal workflow and mark the run
// failed with a "Cancelled by <user>" reason (reusing the terminal `failed` status — no new
// enum). Cancelling frees the org's single active slot immediately, so a misconfigured run no
// longer locks the team out until budget exhaustion or the staleness reaper.
export async function cancelOptimizationRun(
  runId: string
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("cancel optimization runs");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;
  const { email } = ctx;

  // Org-scoped: a caller can only cancel their own team's runs.
  const { data: run, error: runErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id", "status", "workflow_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) return { error: "Optimization run not found" };
  if (!isActiveOptimizationStatus(run.status as OptimizationRunStatus)) {
    return { error: "This run has already finished" };
  }

  const reason = `Cancelled by ${email ?? "a teammate"}`;

  // Terminate the durable workflow if one was started. terminate() is abrupt — the workflow's
  // own failure path doesn't run — so this action is authoritative for the run row below. The
  // workflow may already be gone (it finished between our read and now); log and proceed so the
  // org's active slot still frees.
  if (run.workflow_id) {
    try {
      const client = await getTemporalClient();
      await client.workflow.getHandle(run.workflow_id).terminate(reason);
    } catch (err) {
      await log.error("Failed to terminate optimization workflow", {
        event: "optimization_run.workflow_terminate_failed",
        opt_run_id: runId,
        workflow_id: run.workflow_id,
        error: err,
      });
    }
  }

  // Compare-and-set on the active statuses: if the run reached a terminal state between our
  // read and now (e.g. the workflow's completeRun landed first), the guard makes this a no-op
  // rather than clobbering a legitimately-completed run's result back to failed.
  const { data: updated, error: updErr } = await tenantDb(ctx)
    .from("optimization_runs")
    // paused_reason cleared: a cancelled run is no longer waiting on anything (#102).
    .update({ status: "failed", error_message: reason, paused_reason: null })
    .eq("id", runId)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .select("id");
  if (updErr) {
    await log.error("Failed to mark optimization run cancelled", {
      event: "optimization_run.cancel_failed",
      opt_run_id: runId,
      error: updErr,
    });
    return { error: "Failed to cancel the run" };
  }
  if (!updated || updated.length === 0) {
    // No active row transitioned — the run finished first. Don't report a false cancel.
    return { error: "This run has already finished" };
  }

  // The allowance unit is NOT settled here: terminate() is abrupt and in-flight
  // activities can still commit rollouts for a few seconds, so settling now
  // could mis-derive "no work happened" and release a consumed unit. The
  // reaper's settlement sweep (~1 min cadence) settles the now-failed run after
  // those writes have quiesced, with the accurate worked/released outcome.

  // A user cancel terminates the workflow abruptly, so the worker never runs
  // completeRun/failRun — this is the only place a cancelled run's terminal
  // transition becomes a queryable Logs record, the cancel parallel to the
  // worker's `optimization_run.completed/failed`.
  await log.info("optimization run cancelled", {
    event: "optimization_run.cancelled",
    opt_run_id: runId,
    org_id: orgId,
  });

  await track({ name: "optimization_run.cancelled", props: {} }, { userId });
  revalidatePath("/optimizations");
  return { ok: true };
}

// ---------- Retry now ----------

// Resume a paused Optimization Run immediately (#102). A run pauses when its agent endpoint
// suffers a sustained outage; the workflow auto-probes on a backoff schedule, but a user who
// knows the endpoint is back can skip the wait — this signals the live workflow, which
// resumes from exactly where it paused. The "Retry now" button (follow-up UI) calls this.
export async function retryOptimizationRun(
  runId: string
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("retry optimization runs");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;

  // Org-scoped: a caller can only retry their own team's runs.
  const { data: run, error: runErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id", "status", "workflow_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) return { error: "Optimization run not found" };
  // The generated DB enum (database.types.ts) predates the "paused" status value
  // (#102) — cast past it, same as cancelOptimizationRun's read of this column.
  if ((run.status as OptimizationRunStatus) !== "paused") {
    return { error: "This run isn't paused" };
  }
  if (!run.workflow_id) return { error: "This run has no workflow to resume" };

  // Signal by name — workflow code must never enter the Next bundle (same rule as starting
  // by string name). Signalling is async on the workflow side: the run flips back to
  // 'running' when the workflow's resume Activity lands, not in this request.
  try {
    const client = await getTemporalClient();
    await client.workflow.getHandle(run.workflow_id as string).signal(OPTIMIZATION_RETRY_NOW_SIGNAL);
  } catch (err) {
    await log.error("Failed to signal optimization workflow", {
      event: "optimization_run.retry_signal_failed",
      opt_run_id: runId,
      workflow_id: run.workflow_id,
      error: err,
    });
    return { error: "Failed to retry the run" };
  }

  await log.info("optimization run retried", {
    event: "optimization_run.retried",
    opt_run_id: runId,
    org_id: orgId,
  });

  await track({ name: "optimization_run.retried", props: {} }, { userId });
  revalidatePath("/optimizations");
  return { ok: true };
}

// ---------- Read ----------

// Resolve a Supabase nested relation (object or single-element array, depending on the
// join) down to its `name`. Mirrors the helper the Schedules layout uses.
function nestedName(rel: unknown): string {
  if (Array.isArray(rel)) return String((rel[0] as { name?: unknown } | undefined)?.name ?? "—");
  if (rel && typeof rel === "object") return String((rel as { name?: unknown }).name ?? "—");
  return "—";
}

// A `numeric(4,3)` column (best_score, seed_score) can arrive as a string from PostgREST;
// coerce so the row's score math (fmtScore/hasLift) never sees a string. Shared by both
// score columns in both the list and detail reads below.
function nullableScore(value: unknown): number | null {
  return value == null ? null : Number(value);
}

// The Optimizations list is server-rendered and soft-refreshed (router.refresh) on an interval
// while a run is active, so the whole-history read+render re-fires every poll as the table grows
// (scheduled optimizations accrue runs). The most-recent window is all the surface needs: the
// single active run that gates hasActiveRun is always newest-first (one run per org at a time), no
// displayed total sums the list, and the list already shows a retention note (#187). Mirrors the
// rubric run-history .limit(100) on the eval-runs surface.
const OPTIMIZATION_RUNS_DISPLAY_LIMIT = 100;

// List the active team's Optimization Runs, newest first, for the Optimizations surface.
// A run has no name, so each row carries its agent Connection + Rubric names and status.
export async function listOptimizationRuns(): Promise<OptimizationRunSummary[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  // Stays on the raw admin client: this read pulls a PostgREST embed
  // (`connections!inner(...)`, `rubrics!inner(...)`) that the typed tenantDb
  // `select(...columns)` can't express. It's still org-scoped by the explicit
  // `.eq("org_id", orgId)` below (mirrors getSchedule's embed read).
  const { data, error } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- PostgREST embed select tenantDb can't express; org-scoped by the explicit .eq("org_id") — see comment above
    .from("optimization_runs")
    .select(
      "id, status, best_score, seed_score, created_at, connections!inner(name), rubrics!inner(name)"
    )
    .eq("org_id", orgId)
    .is("deleted_at", null) // hide runs aged out of the plan's retention window (#187)
    .order("created_at", { ascending: false })
    .limit(OPTIMIZATION_RUNS_DISPLAY_LIMIT);
  if (error) throw error;
  const rows = data ?? [];

  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as OptimizationRunStatus,
    best_score: nullableScore(r.best_score),
    // Persisted at the completion transition (#113) — null for a run completed before this
    // column existed, or one that isn't complete yet; either way the read surface claims no lift.
    seed_score: nullableScore(r.seed_score),
    created_at: r.created_at as string,
    connection_name: nestedName(r.connections),
    rubric_name: nestedName(r.rubrics),
  }));
}

// Read an Optimization Run's status + result for the active team. Returns null if the run
// isn't found in the caller's org (no cross-team leakage).
export async function getOptimizationRun(id: string) {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  // Stays on the raw admin client: this read pulls a PostgREST embed
  // (`connections!inner(...)`, `rubrics!inner(...)`) that the typed tenantDb
  // `select(...columns)` can't express. It's still org-scoped by the explicit
  // `.eq("org_id", orgId)` below (mirrors getSchedule's embed read).
  const { data: run, error: runError } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- PostgREST embed select tenantDb can't express; org-scoped by the explicit .eq("org_id") — see comment above
    .from("optimization_runs")
    .select("*, connections!inner(name), rubrics!inner(name)")
    .eq("id", id)
    .eq("org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run's detail page 404s like any unknown id (#187)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return null;

  // The run row is fetched and gates everything below; the remaining child reads all key only on
  // the run id (plus already-known run columns), so they're mutually independent — fan them out in
  // one round trip instead of awaiting each in turn. This is the active-run detail page's poll
  // path, so collapsing the waterfall directly cuts per-poll latency.
  //
  // Derived progress for the in-progress detail (no persisted progress columns, per #105):
  // Candidates discovered so far, and rollouts spent — both head-counted from child rows. Only
  // computed for an active run, since a terminal run's detail shows its result, not progress.
  // Rollouts hang off candidates (no opt_run_id of their own), so count them through an inner
  // join on the run's candidates rather than fetching candidate ids and re-sending them in an
  // IN list — that avoids PostgREST's 1000-row cap and request-URL length limits entirely.
  const isActive = isActiveOptimizationStatus(run.status as OptimizationRunStatus);
  const [
    { count: instanceCount, error: instanceCountError },
    candidateCountRes,
    rolloutsRes,
    { data: seed, error: seedError },
    winnerRes,
  ] = await Promise.all([
    supabaseAdmin
      .from("optimization_inputs")
      .select("id", { count: "exact", head: true })
      .eq("opt_run_id", id),
    isActive
      ? supabaseAdmin
          .from("optimization_candidates")
          .select("id", { count: "exact", head: true })
          .eq("opt_run_id", id)
      : Promise.resolve(null),
    isActive
      ? supabaseAdmin
          .from("optimization_rollouts")
          .select("id, optimization_candidates!inner(opt_run_id)", { count: "exact", head: true })
          .eq("optimization_candidates.opt_run_id", id)
      : Promise.resolve(null),
    // Seed Candidate (generation 0) holds the Connection's seed prompts: the diff's "before"
    // and the lift baseline.
    supabaseAdmin
      .from("optimization_candidates")
      .select("id, prompts")
      .eq("opt_run_id", id)
      .eq("generation", 0)
      .maybeSingle(),
    // Winning Candidate (best_candidate_id) holds the diff's "after". Null until a run produces
    // a validated winner (i.e. not for queued/running/most failed runs).
    run.best_candidate_id
      ? supabaseAdmin
          .from("optimization_candidates")
          .select("prompts")
          .eq("id", run.best_candidate_id as string)
          .maybeSingle()
      : Promise.resolve(null),
  ]);
  if (instanceCountError) throw instanceCountError;

  let candidateCount = 0;
  let rolloutsSpent = 0;
  if (isActive) {
    if (candidateCountRes!.error) throw candidateCountRes!.error;
    candidateCount = candidateCountRes!.count ?? 0;
    if (rolloutsRes!.error) throw rolloutsRes!.error;
    rolloutsSpent = rolloutsRes!.count ?? 0;
  }

  if (seedError) throw seedError;

  let winningPrompts: Record<string, string> | null = null;
  if (run.best_candidate_id) {
    if (winnerRes!.error) throw winnerRes!.error;
    winningPrompts = (winnerRes!.data?.prompts as Record<string, string> | undefined) ?? null;
  }

  // Persisted at the completion transition (#113) — null for a run completed before this column
  // existed, or one that isn't complete yet; either way the detail view claims no lift.
  const seedScore = nullableScore(run.seed_score);

  return {
    run,
    instanceCount: instanceCount ?? 0,
    candidateCount,
    rolloutsSpent,
    seedPrompts: (seed?.prompts as Record<string, string> | undefined) ?? null,
    winningPrompts,
    seedScore,
    // Why the run is paused (#102) — e.g. "waiting for your endpoint to recover". Set while
    // status = 'paused', null otherwise (resume/fail/cancel clear it). Surfaced explicitly so
    // the detail view doesn't dig it out of the raw row.
    pausedReason: (run.paused_reason as string | null) ?? null,
    // Why a completed run ended without ever entering iteration 1 (#469) — a reason CODE
    // (TerminationReason), not prose; the detail panel translates it. Null for a normal
    // completion and for every non-completed run. Same shape as pausedReason above.
    terminationReason: (run.termination_reason as string | null) ?? null,
  };
}
