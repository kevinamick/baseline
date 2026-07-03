"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { requireContributor } from "@/lib/auth/require-contributor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { firstRow } from "@/lib/supabase/first-row";
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
  overallScoreFromResults,
  type ScoredCriterion,
  type CriterionResult,
} from "@/lib/optimization/score";
import {
  ACTIVE_OPTIMIZATION_STATUSES,
  isActiveOptimizationStatus,
  type OptimizationRunStatus,
  type OptimizationRunSummary,
} from "@/types/optimization";

// The phases that score a Candidate on the full frozen set: GEPA's 'pareto' and Simple Mode's
// 'full' (vs the cheap accept/reject 'minibatch'). A seed Candidate has full-set rollouts in
// exactly one of these depending on the run's Mode, so matching either recovers its overall
// score for the lift baseline regardless of Mode (ADR-0015).
const FULL_SET_PHASES = ["pareto", "full"] as const;

// ---------- Start ----------

// Start a manual, one-shot Optimization Run (#87). Authz (Contributor), snapshot the manual
// instances into a frozen set, enforce one active run per org, then start the durable
// Temporal workflow. Per ADR-0006 the workflow carries only the run id — Activities read the
// prompts/instances and write rollouts/results back to Postgres.
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
  const { data: rubric, error: rubricErr } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- org-scoped by the explicit .eq("org_id", orgId); pending tenantDb migration (#207)
    .from("rubrics")
    .select("id, criteria")
    .eq("id", o.rubricId)
    .eq("org_id", orgId)
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
  const runJudgeModel =
    runProvider === ESTIMATE_JUDGE_PROVIDER ? ESTIMATE_JUDGE_MODEL : PROVIDER_DEFAULT_JUDGE_MODEL[runProvider];
  const proposerCalls = o.mode === "simple" ? o.budgetRollouts : o.maxIters;
  const managedSpendTerms: ManagedSpendTerm[] = [
    {
      keyModeStrategy: KEY_MODE_STRATEGY.perProvider,
      provider: runProvider,
      model: runJudgeModel,
      volume: o.budgetRollouts * o.instances.length,
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
            volume: o.budgetRollouts * o.instances.length,
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
    o.instances.map((row, i) => ({
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
      props: { instance_count: o.instances.length, budget: o.budgetRollouts },
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
  const { userId, orgId } = gate;

  // Org-scoped: a caller can only retry their own team's runs.
  const { data: run, error: runErr } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- org-scoped by the explicit .eq("org_id", orgId); pending tenantDb migration (#207)
    .from("optimization_runs")
    .select("id, status, workflow_id")
    .eq("id", runId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) return { error: "Optimization run not found" };
  if (run.status !== "paused") return { error: "This run isn't paused" };
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

// Resolve a Supabase nested rubric relation (object or single-element array) down to the
// {name, weight} pairs the overall-score formula needs. Steps and other fields are ignored.
function rubricCriteria(rel: unknown): ScoredCriterion[] {
  const rubric = firstRow(rel);
  const criteria = (rubric as { criteria?: unknown } | undefined)?.criteria;
  if (!Array.isArray(criteria)) return [];
  return criteria.map((c) => ({
    name: String((c as { name?: unknown }).name ?? ""),
    weight: Number((c as { weight?: unknown }).weight ?? 0),
  }));
}

// The seed Candidate's overall score on the full frozen set — the lift baseline. Not persisted
// (only the winner's best_score is), so recompute it from the seed's full-set rollout_results.
// Returns null when the seed has no full-set rollouts yet (e.g. a run that never got that far).
async function seedOverallScore(
  seedCandidateId: string,
  criteria: ScoredCriterion[]
): Promise<number | null> {
  if (criteria.length === 0) return null;

  const { data: rollouts, error: rolloutsError } = await supabaseAdmin
    .from("optimization_rollouts")
    .select("id")
    .eq("candidate_id", seedCandidateId)
    .in("phase", FULL_SET_PHASES);
  if (rolloutsError) throw rolloutsError;
  const rolloutIds = (rollouts ?? []).map((r) => r.id as string);
  if (rolloutIds.length === 0) return null;

  const { data: results, error: resultsError } = await supabaseAdmin
    .from("rollout_results")
    .select("criterion_name, score")
    .in("rollout_id", rolloutIds);
  if (resultsError) throw resultsError;

  return overallScoreFromResults(
    criteria,
    (results ?? []).map((r) => ({
      criterion_name: r.criterion_name as string,
      score: Number(r.score),
    }))
  );
}

// Seed scores for a batch of runs, in three bounded queries (not N+1): all seed Candidates,
// their full-set rollouts, then those rollouts' results — grouped back per run and scored with
// each run's own rubric weights. Runs without a resolvable seed score are simply absent.
async function seedScoresByRun(
  runs: { id: string; criteria: ScoredCriterion[] }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (runs.length === 0) return out;

  const { data: seeds, error: seedsError } = await supabaseAdmin
    .from("optimization_candidates")
    .select("id, opt_run_id")
    .in("opt_run_id", runs.map((r) => r.id))
    .eq("generation", 0);
  if (seedsError) throw seedsError;
  const seedRows = (seeds ?? []) as { id: string; opt_run_id: string }[];
  if (seedRows.length === 0) return out;
  const runBySeed = new Map(seedRows.map((s) => [s.id, s.opt_run_id]));

  const { data: rollouts, error: rolloutsError } = await supabaseAdmin
    .from("optimization_rollouts")
    .select("id, candidate_id")
    .in("candidate_id", seedRows.map((s) => s.id))
    .in("phase", FULL_SET_PHASES);
  if (rolloutsError) throw rolloutsError;
  const rolloutRows = (rollouts ?? []) as { id: string; candidate_id: string }[];
  if (rolloutRows.length === 0) return out;
  const runByRollout = new Map<string, string>();
  for (const ro of rolloutRows) {
    const runId = runBySeed.get(ro.candidate_id);
    if (runId) runByRollout.set(ro.id, runId);
  }

  const { data: results, error: resultsError } = await supabaseAdmin
    .from("rollout_results")
    .select("rollout_id, criterion_name, score")
    .in("rollout_id", rolloutRows.map((r) => r.id));
  if (resultsError) throw resultsError;

  const resultsByRun = new Map<string, CriterionResult[]>();
  for (const res of (results ?? []) as {
    rollout_id: string;
    criterion_name: string;
    score: number;
  }[]) {
    const runId = runByRollout.get(res.rollout_id);
    if (!runId) continue;
    const list = resultsByRun.get(runId) ?? [];
    list.push({ criterion_name: res.criterion_name, score: Number(res.score) });
    resultsByRun.set(runId, list);
  }

  const criteriaByRun = new Map(runs.map((r) => [r.id, r.criteria]));
  for (const [runId, res] of resultsByRun) {
    const criteria = criteriaByRun.get(runId) ?? [];
    // Mirror seedOverallScore (the detail path): no criteria means no baseline, so leave the
    // run absent rather than emitting a 0 that reads as a real "0.00 → best" lift on the row.
    if (criteria.length === 0) continue;
    out.set(runId, overallScoreFromResults(criteria, res));
  }
  return out;
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

  const { data, error } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- org-scoped by the explicit .eq("org_id", orgId); pending tenantDb migration (#207) — embed select
    .from("optimization_runs")
    .select(
      "id, status, best_score, created_at, connections!inner(name), rubrics!inner(name, criteria)"
    )
    .eq("org_id", orgId)
    .is("deleted_at", null) // hide runs aged out of the plan's retention window (#187)
    .order("created_at", { ascending: false })
    .limit(OPTIMIZATION_RUNS_DISPLAY_LIMIT);
  if (error) throw error;
  const rows = data ?? [];

  // Only completed runs show a score lift, so only they need a seed-score baseline. Compute
  // those in one bounded batch rather than a query per row.
  const completed = rows
    .filter((r) => r.status === "completed")
    .map((r) => ({ id: r.id as string, criteria: rubricCriteria(r.rubrics) }));
  const seedScores = await seedScoresByRun(completed);

  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as OptimizationRunStatus,
    // numeric(4,3) can arrive as a string from PostgREST; coerce so the row's score math
    // (fmtScore/hasLift) never sees a string.
    best_score: r.best_score == null ? null : Number(r.best_score),
    seed_score: seedScores.get(r.id as string) ?? null,
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

  const { data: run, error: runError } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- org-scoped by the explicit .eq("org_id", orgId); pending tenantDb migration (#207) — embed select
    .from("optimization_runs")
    .select("*, connections!inner(name), rubrics!inner(name, criteria)")
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

  const seedScore = seed
    ? await seedOverallScore(seed.id as string, rubricCriteria(run.rubrics))
    : null;

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
  };
}
