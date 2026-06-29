"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
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
import {
  DEFAULT_SIMPLE_REFLECT_MODEL,
  providerForReflectModel,
  PROVIDER_DEFAULT_JUDGE_MODEL,
} from "@/lib/optimization/models";
import { insertConnection } from "@/lib/connections/create";
import {
  getOptimizationAllowance,
  reserveOptimizationRun,
  reserveOptimizationPoints,
  settleOptimizationRunUnit,
  settleOptimizationRunPoints,
} from "@/lib/billing/allowance";
import { evalRunPointsPerRow, optimizationRunPointCost } from "@/lib/billing/points";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { getSeatCapState, seatCapError } from "@/lib/billing/seats";
import { maybeWarnNearCap, notifyCapReached } from "@/lib/billing/overage";
import { managedRunBlockedForPayment, resolveKeyModeForEstimate, KEY_MODE } from "@/lib/llm/key-gate";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import {
  getEffectiveManagedCap,
  reserveManagedSpend,
  notifyManagedCapReached,
} from "@/lib/billing/managed-spend";
import {
  ESTIMATE_JUDGE_MODEL,
  ESTIMATE_JUDGE_PROVIDER,
  ESTIMATE_REFLECT_MODEL,
} from "@/lib/llm/model-prices";
import { PLANS } from "@/lib/billing/plans";
import { fmtUsd } from "@/lib/billing/format";
import { optimizationLimitEmailHtml } from "@/lib/email/templates/optimization-limit";
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
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can start optimization runs" };

  const parsed = CreateOptimizationRunSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid optimization run" };
  }
  const o = parsed.data;

  // Seat-cap gate (#182): same fail-closed rule as eval runs.
  const seats = await getSeatCapState(orgId);
  if (seats.violated) {
    return { error: seatCapError(seats, "start optimization runs") };
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

  // Managed-payment fail-closed gate (#186): a declined managed-token threshold invoice pauses
  // MANAGED runs until payment recovers. BYO runs pass through. Check the reflect provider AND the
  // Managed Agent target provider independently (#204): a run judging on a BYO reflect key can still
  // drive a managed target, so a target-provider payment failure must block it too — mirroring the
  // per-provider managed-spend reserve below. managedRunBlockedForPayment is false for any non-
  // managed (BYO/Free) provider, so this only fires when a provider truly resolves to managed.
  const targetPaymentProvider = targetModel ? providerForReflectModel(targetModel) : null;
  if (
    (await managedRunBlockedForPayment(orgId, runProvider)) ||
    (targetPaymentProvider != null &&
      (await managedRunBlockedForPayment(orgId, targetPaymentProvider)))
  ) {
    await cleanupCreatedConnection();
    return {
      error:
        "Managed runs are paused: a managed-token payment failed. Update your card under Settings → Billing — runs resume automatically once it's paid — or add your own provider key under Settings → Team.",
    };
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

  // Reserve the run atomically (#181, ADR-0016). The run row must exist first
  // (the reservation references it); a refusal rolls the insert back. A run
  // WITHIN the included run-count consumes one allowance unit and zero points
  // (today's path); a paid Team PAST its included count meters worst-case Eval
  // Points (`budget_rollouts × per-rollout cost`) instead of hard-blocking.
  // Free never reaches here — the included === 0 wall above stops it.
  const drawsPoints = allowance.remaining < 1;
  const perRolloutCost = evalRunPointsPerRow(criteriaCount);
  const worstCasePoints = optimizationRunPointCost(o.budgetRollouts, criteriaCount);

  // Roll the run back. The settle(s) must land BEFORE the delete (the delete
  // nulls the ledger FKs, after which the reservations are unfindable). Both
  // settles are no-ops for the meter this run didn't touch. If a settle fails,
  // LEAVE the run row: the reaper fails-and-settles queued runs with no
  // workflow within ~1 minute — a briefly-held active slot beats a reservation
  // stranded for the whole period.
  const rollBackRun = async () => {
    const unit = await settleOptimizationRunUnit(run.id);
    const pts = await settleOptimizationRunPoints(run.id, "skipped");
    if (unit.error || pts.error) {
      await log.error("allowance release failed — leaving the run for the reaper to settle", {
        event: "optimization_run.allowance_release_failed",
        opt_run_id: run.id,
        org_id: orgId,
        error: unit.error ?? pts.error,
      });
      return;
    }
    await tenantDb(ctx).from("optimization_runs").delete().eq("id", run.id);
  };

  // Normalized reservation context the downstream managed-spend gate reads,
  // regardless of which meter funded the run.
  let reservation: { plan: typeof allowance.plan; periodStart: string };

  if (!drawsPoints) {
    // Within the included run-count: one allowance unit, zero points.
    let unit: Awaited<ReturnType<typeof reserveOptimizationRun>>;
    try {
      unit = await reserveOptimizationRun(orgId, run.id, {
        periodStart: allowance.periodStart,
        periodEnd: allowance.periodEnd,
        included: allowance.included,
        plan: allowance.plan,
      });
    } catch (err) {
      await log.error("allowance reservation errored", {
        event: "optimization_run.reserve_failed",
        opt_run_id: run.id,
        org_id: orgId,
        error: err,
      });
      await rollBackRun();
      await cleanupCreatedConnection();
      return { error: "Couldn't check your team's run allowance. Please try again." };
    }
    if (!unit.reserved) {
      // A concurrent run took the last included unit between the pre-check and
      // here. Refuse cleanly; the next attempt falls into the points branch.
      await tenantDb(ctx).from("optimization_runs").delete().eq("id", run.id);
      await cleanupCreatedConnection();
      await notifyLimitOnce({
        orgId,
        kind: "optimization_runs_limit",
        periodStart: unit.periodStart,
        subject: (teamName) => `${teamName} has used its Optimization Runs for this period`,
        html: (teamName, billingUrl) =>
          optimizationLimitEmailHtml({ teamName, included: allowance.included, billingUrl }),
      });
      return {
        error: `Your team has used all ${allowance.included} Optimization Runs included this period.`,
      };
    }
    reservation = { plan: unit.plan, periodStart: unit.periodStart };
  } else {
    // Paid Team past its included run-count: meter worst-case Eval Points.
    let points: Awaited<ReturnType<typeof reserveOptimizationPoints>>;
    try {
      points = await reserveOptimizationPoints(orgId, run.id, worstCasePoints, {
        criteria_count: criteriaCount,
        budget_rollouts: o.budgetRollouts,
        per_rollout_cost: perRolloutCost,
      });
    } catch (err) {
      await log.error("optimization point reservation errored", {
        event: "optimization_run.points_reserve_failed",
        opt_run_id: run.id,
        org_id: orgId,
        error: err,
      });
      await rollBackRun();
      await cleanupCreatedConnection();
      return { error: "Couldn't check your team's Eval Point balance. Please try again." };
    }
    if (!points.reserved) {
      await tenantDb(ctx).from("optimization_runs").delete().eq("id", run.id);
      await cleanupCreatedConnection();
      await track(
        {
          name: "billing.optimization_limit_hit",
          props: { team_id: orgId, included: allowance.included, cap_usd: points.capUsd },
        },
        { userId }
      );
      // Payment-failing (#215) wins over the cap message: overage was suppressed
      // because the card is failing, so it's "update your card", not "hit cap".
      if (points.paymentFailing) {
        return {
          error: `Optimization Run overage is paused because your team's payment method is failing — update your card in Billing to start runs beyond the ${allowance.included} included this period.`,
        };
      }
      if (points.capUsd != null) {
        await notifyCapReached(orgId, points.capUsd, points.periodStart);
        return {
          error: `This optimization run needs ${worstCasePoints.toLocaleString()} Eval Points, but your team has used its included Optimization Runs and another would take it past its $${points.capUsd} monthly overage cap.`,
        };
      }
      await notifyLimitOnce({
        orgId,
        kind: "optimization_runs_limit",
        periodStart: points.periodStart,
        subject: (teamName) => `${teamName} has used its Optimization Runs for this period`,
        html: (teamName, billingUrl) =>
          optimizationLimitEmailHtml({ teamName, included: allowance.included, billingUrl }),
      });
      return {
        error: `Your team has used its ${allowance.included} included Optimization Runs, and this run's ${worstCasePoints.toLocaleString()} Eval Points exceed your remaining balance. Add Eval Points or set an Overage Cap in Billing.`,
      };
    }
    reservation = { plan: points.plan, periodStart: points.periodStart };

    // Funded — possibly into cap-backed overage; the 80% warning may be due.
    // (Skipped when the reserve left the balance non-negative: committed
    // overage didn't change, so no threshold can have been crossed by it.)
    if (points.capUsd != null && points.balance < 0) {
      await maybeWarnNearCap(orgId, {
        capUsd: points.capUsd,
        plan: points.plan,
        periodStart: points.periodStart,
      });
    }
  }

  // Managed Spend Cap pre-run gate (#185, #204). A run is multi-provider at the call level: the
  // judge + reflect calls run on the run's reflect/generation provider (`runProvider`), while a
  // Managed Agent's target call runs on its own provider (Anthropic today). Each term is reserved
  // ONLY when ITS provider resolves to the managed key — so a non-Anthropic BYO reflect run never
  // reserves managed judge/reflect spend it won't meter, yet a Managed Agent's managed Anthropic
  // target is STILL reserved even when the reflect side is BYO (else the dominant target spend
  // would run uncapped/unmetered — the worker finds no reserve row and meters nothing). Coarse
  // estimate: rollout judging + target inference dominate, reflection is a small add. The reserve
  // row also snapshots the markup + cap the worker meter reads back to enforce exactly, mid-run,
  // so the estimate here only gates "don't start if already at the cap".
  // The run's judge model is its provider's fast model (the worker's defaultJudgeModelForProvider),
  // mirrored by PROVIDER_DEFAULT_JUDGE_MODEL per provider. Anthropic keeps the ESTIMATE_JUDGE_MODEL
  // constant (the estimate default, pinned to the worker's DEFAULT_JUDGE_MODEL by the parity test).
  const runJudgeModel =
    runProvider === ESTIMATE_JUDGE_PROVIDER ? ESTIMATE_JUDGE_MODEL : PROVIDER_DEFAULT_JUDGE_MODEL[runProvider];
  const runProviderManaged = (await resolveKeyModeForEstimate(orgId, runProvider)) === KEY_MODE.managed;
  // The Managed Agent target runs on its own provider's key, resolved independently of the run's
  // reflect provider (#204): a paid Team judging on a BYO reflect key still runs the managed target.
  const targetProvider = targetModel ? providerForReflectModel(targetModel) : null;
  const targetManaged = targetProvider
    ? (await resolveKeyModeForEstimate(orgId, targetProvider)) === KEY_MODE.managed
    : false;

  if (runProviderManaged || targetManaged) {
    let estimate = 0;
    if (runProviderManaged) {
      const judgeEst =
        estimateManagedSpendUsd(
          reservation.plan,
          runProvider,
          runJudgeModel,
          o.budgetRollouts * o.instances.length,
          criteriaCount
        ) ?? 0;
      // The prompt-proposer term. GEPA reflects once per iteration (max_iters calls); Simple Mode
      // generates one rewrite per Candidate, coarsely bounded by budget_rollouts. The model is the
      // run's reflect_model (Sonnet for GEPA, Haiku for Simple, or the wizard override).
      const proposerCalls = o.mode === "simple" ? o.budgetRollouts : o.maxIters;
      const reflectEst =
        estimateManagedSpendUsd(
          reservation.plan,
          runProvider,
          reflectModel ?? ESTIMATE_REFLECT_MODEL,
          proposerCalls,
          1
        ) ?? 0;
      estimate += judgeEst + reflectEst;
    }
    // Managed Agent (#291): when the System itself runs on the managed key, the target-model
    // inference is the DOMINANT spend term (one call per rollout × instance, swamping the judge),
    // so the cap gate must reserve it too or a run could start already past the cap. Reserved
    // whenever the target is managed, regardless of the reflect provider's key mode (#204).
    if (targetManaged && targetModel && targetProvider) {
      estimate +=
        estimateManagedSpendUsd(
          reservation.plan,
          targetProvider,
          targetModel,
          o.budgetRollouts * o.instances.length,
          1
        ) ?? 0;
    }
    let capResult: Awaited<ReturnType<typeof getEffectiveManagedCap>>;
    try {
      capResult = await getEffectiveManagedCap(orgId);
    } catch (err) {
      await log.error("managed cap check errored", { event: "opt_run.managed_cap_check_failed", run_id: run.id, org_id: orgId, error: err });
      await rollBackRun();
      await cleanupCreatedConnection();
      return { error: "Couldn't check your team's managed spend cap. Please try again." };
    }
    const { capUsd } = capResult;
    const markupPct = PLANS[reservation.plan].managedMarkupPct;
    if (estimate > 0 && capUsd != null && markupPct != null) {
      const { reserved } = await reserveManagedSpend(
        orgId,
        { optRunId: run.id },
        estimate,
        capUsd,
        markupPct,
        { start: allowance.periodStart, end: allowance.periodEnd }
      );
      if (!reserved) {
        await rollBackRun();
        await cleanupCreatedConnection();
        await track(
          {
            name: "billing.managed_spend_limit_hit",
            props: { team_id: orgId, estimate_usd: estimate, cap_usd: capUsd },
          },
          { userId }
        );
        await notifyManagedCapReached(orgId, capUsd, reservation.periodStart);
        return {
          error: `This optimization run's estimated managed token spend would take your team past its ${fmtUsd(capUsd)} monthly managed spend cap. Raise the cap on the Billing page, or add your own provider key under Settings → Team.`,
        };
      }
    }
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
    await rollBackRun();
    await cleanupCreatedConnection();
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
    await rollBackRun();
    await cleanupCreatedConnection();
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
  const ctx = await getAuthContext();
  const { userId, orgId, email, canWrite } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can cancel optimization runs" };

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
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can retry optimization runs" };

  // Org-scoped: a caller can only retry their own team's runs.
  const { data: run, error: runErr } = await supabaseAdmin
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
    await log.error("Failed to signal optimization workflow", { error: err });
    return { error: "Failed to retry the run" };
  }

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
