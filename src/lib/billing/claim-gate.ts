import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSeatCapState } from "@/lib/billing/seats";
import { evalRunPointCost, evalRunPointsPerRow } from "@/lib/billing/points";
import { resolvePointPeriod } from "@/lib/billing/ledger";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { seatCapEmailHtml } from "@/lib/email/templates/seat-cap";
import { ESTIMATE_JUDGE_MODEL, ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";
import {
  checkRunPreflight,
  reserveRunOrRefuse,
  RUN_KIND,
  RUN_REFUSAL,
  KEY_MODE_STRATEGY,
  type ManagedSpendTerm,
  type RunGateResult,
} from "@/lib/billing/run-gate";

/**
 * Claim-time billing gate for SCHEDULE-spawned eval runs (#199), now a thin
 * shim over the Run Gate (#377) — the third and final caller (#382 ported
 * `startOptimizationRun`). `tick_schedules()` inserts scheduled eval_runs
 * directly in SQL with no Point reserve and no seat-cap check, so a Team
 * that's blocked interactively (Free quota exhausted, or over the seat cap
 * after an executed downgrade) would keep producing runs every tick,
 * unmetered. Interactive runs are already gated at creation (createEvalRun) —
 * this closes the schedule hole at the only other place the run's cost is
 * knowable: worker claim time, once the rows exist (tick copies tabular
 * inputs; the worker fetches dataset rows before this runs).
 *
 * The worker can't import this (separate package), so it reaches it through the
 * internal `/api/internal/claim-reserve` route, which is a thin auth wrapper over
 * this function. Delegating to the Run Gate keeps the scheduled path's precedence
 * (seat cap → Eval Point reserve → Managed Spend Cap reserve, payment-failing
 * beats the cap message) identical to the interactive one, in the one module that
 * owns it.
 *
 * TWO divergences from the Run Gate's other caller stay caller-owned, by design:
 *   - The seat-cap NOTIFICATION email: no user is watching a schedule tick, so this
 *     path alone emails the team when `checkRunPreflight` refuses on `seat_cap`.
 *     `checkRunPreflight` itself only ever returns `seat_cap` here — the missing-key
 *     and managed-payment-failing preflight checks are both opted out
 *     (`requireProviderKeyForFreePlan: false`, `managedPaymentCheckProviders: []`):
 *     the claim gate never gated either before this port, and a Managed Agent's
 *     paid-plan requirement is covered instead by the `requiresPaidPlan` term below.
 *   - Rollback: the run row here PRE-EXISTS (tick_schedules already inserted it)
 *     and must never be deleted or have its reservations released by this gate —
 *     on any refusal after a successful Point reserve, that reservation is settled
 *     later by the worker's terminal 'failed' write (settle_eval_run_points +
 *     release_managed_reservation), not here. So both `RunGateCallbacks` below are
 *     intentionally no-ops.
 *
 * IDEMPOTENT: a run that already holds a reserve (an interactive run, or a
 * re-delivered message) returns `allowed` without a second reserve —
 * reserve_eval_points has a one-reserve-per-run unique index that would error on
 * a double call. Unknown/foreign runs also pass through (nothing to gate); the
 * worker's own org-scoping owns that.
 */
export type ClaimGateResult =
  | { allowed: true }
  | { allowed: false; reason: "seat_cap" | "insufficient_points" | "managed_cap" | "managed_not_paid" };

// The claim path's run row pre-exists (inserted by tick_schedules SQL, not by
// this function) and must survive any refusal — the worker settles/releases
// whatever was reserved when it later writes the run's terminal 'failed'
// status. Deleting the row or releasing here would race that settlement and
// orphan the FK the release RPCs look up by.
const NOOP_CALLBACKS = {
  deleteRun: async () => {},
  rollbackReservations: async () => {},
};

export async function gateScheduledRunBilling(runId: string): Promise<ClaimGateResult> {
  const { data: run, error: runErr } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubric_id, schedule_id, created_by")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run?.rubric_id) return { allowed: true };

  // Already reserved (interactive run, or a redelivered claim) → no double charge.
  const { data: existingReserve, error: reserveErr } = await supabaseAdmin
    .from("point_ledger")
    .select("id")
    .eq("eval_run_id", runId)
    .eq("entry_type", "reserve")
    .limit(1)
    .maybeSingle();
  if (reserveErr) throw reserveErr;
  if (existingReserve) return { allowed: true };

  const { data: rubric, error: rubricErr } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- claim path has no AuthContext: the org is resolved FROM this row (trusted run linkage; #207 scope boundary)
    .from("rubrics")
    .select("org_id, criteria")
    .eq("id", run.rubric_id)
    .maybeSingle();
  if (rubricErr) throw rubricErr;
  if (!rubric?.org_id) return { allowed: true };
  const orgId = rubric.org_id as string;

  // Run Gate (#377) phase 1: seat-cap only (see the module doc for why the
  // missing-key / managed-payment preflight checks stay opted out here).
  const preflight = await checkRunPreflight({
    runKind: RUN_KIND.eval,
    orgId,
    seatCapMessageKey: "seatCapScheduledEval",
    requireProviderKeyForFreePlan: false,
    managedPaymentCheckProviders: [],
  });
  if (!preflight.ok) {
    // The gate's own refusal carries only a generic message; the claim path's
    // seat-cap refusal additionally emails the team (no user is watching a
    // schedule tick), so refetch the raw state for the email body. This is a
    // duplicate READ of the same decision `checkRunPreflight` already made
    // (not a duplicate of the decision itself) and only happens on the rare
    // refusal path.
    const seats = await getSeatCapState(orgId);
    const period = await resolvePointPeriod(orgId);
    await notifyLimitOnce({
      orgId,
      kind: "seat_cap",
      periodStart: period.start.toISOString(),
      subject: (teamName) => `${teamName} has more members than its plan allows`,
      html: (teamName, billingUrl) =>
        seatCapEmailHtml({
          teamName,
          memberCount: seats.memberCount,
          seatLimit: seats.seatLimit ?? 0,
          billingUrl,
        }),
    });
    return { allowed: false, reason: "seat_cap" };
  }

  // Point reserve (#180/#183/#215): same seam interactive runs use, so the period,
  // plan, cap and payment-failing overage suppression are all consistent.
  const { count, error: rowCountErr } = await supabaseAdmin
    .from("eval_run_rows")
    .select("row_index", { count: "exact", head: true })
    .eq("eval_run_id", runId);
  if (rowCountErr) throw rowCountErr;
  const rowCount = count ?? 0;
  const criteriaCount = Array.isArray(rubric.criteria) ? rubric.criteria.length : 0;
  const cost = evalRunPointCost(rowCount, criteriaCount);

  // A scheduled run can incur TWO managed terms, reserved against the Managed
  // Spend Cap before the worker meters them, mirroring the interactive path
  // (createEvalRun) — the asymmetry between them is now a declared gate input
  // (#383), not divergent inline logic:
  //   - JUDGE (judgeAnyByo): runs on the managed key whenever the Team is paid
  //     with no BYO key for any runtime-ready provider (mirrors the worker's
  //     resolveEvalJudge). Applies to EVERY scheduled run — dataset and
  //     external-agent included, not just Managed Agents — because a managed
  //     judge with no reservation can never be metered (#358).
  //   - TARGET (perProvider + requiresPaidPlan): a Managed Agent System runs
  //     its Anthropic target on the managed key whenever the Team has no
  //     Anthropic BYO key, independent of the judge (which may be BYO on a
  //     different provider) — AND is refused outright on a non-paid plan even
  //     with a BYO key (Managed Agents are paid-plan only, #292; a schedule
  //     created while paid keeps ticking after a downgrade).
  const targetModel = run.schedule_id ? await managedAgentTargetModel(run.schedule_id) : null;
  const managedSpendTerms: ManagedSpendTerm[] = [
    {
      keyModeStrategy: KEY_MODE_STRATEGY.judgeAnyByo,
      provider: ESTIMATE_JUDGE_PROVIDER,
      model: ESTIMATE_JUDGE_MODEL,
      volume: rowCount,
      criteriaCount,
    },
    ...(targetModel
      ? [
          {
            keyModeStrategy: KEY_MODE_STRATEGY.perProvider,
            provider: ESTIMATE_JUDGE_PROVIDER,
            model: targetModel,
            volume: rowCount,
            criteriaCount: 1,
            requiresPaidPlan: true,
          } satisfies ManagedSpendTerm,
        ]
      : []),
  ];

  const reserved = await reserveRunOrRefuse({
    runKind: RUN_KIND.eval,
    orgId,
    userId: run.created_by,
    runId,
    pointReserve: {
      kind: "eval_points",
      pointCost: cost,
      metadata: {
        row_count: rowCount,
        criteria_count: criteriaCount,
        per_row_cost: evalRunPointsPerRow(criteriaCount),
      },
    },
    managedSpendTerms,
    managedSpendRef: { evalRunId: runId },
    callbacks: NOOP_CALLBACKS,
  });

  return toClaimResult(reserved);
}

function toClaimResult(result: RunGateResult): ClaimGateResult {
  if (result.ok) return { allowed: true };
  switch (result.refusal.kind) {
    case RUN_REFUSAL.insufficientPoints:
      return { allowed: false, reason: "insufficient_points" };
    case RUN_REFUSAL.managedCapExceeded:
      return { allowed: false, reason: "managed_cap" };
    case RUN_REFUSAL.managedAgentNotPaid:
      return { allowed: false, reason: "managed_not_paid" };
    case RUN_REFUSAL.seatCap:
    case RUN_REFUSAL.missingKey:
    case RUN_REFUSAL.managedPaymentFailing:
    case RUN_REFUSAL.optimizationAllowanceExhausted:
      // Unreachable from reserveRunOrRefuse — the first three are
      // checkRunPreflight-only kinds (the claim path's preflight above only
      // ever returns seatCap, handled separately, before this call), and the
      // allowance kind belongs to the optimization "unit" branch (#382),
      // which an eval-run claim never requests.
      throw new Error(`claim-gate: unexpected refusal kind from reserveRunOrRefuse: ${result.refusal.kind}`);
    default: {
      const exhaustive: never = result.refusal.kind;
      throw new Error(`claim-gate: unhandled refusal kind: ${String(exhaustive)}`);
    }
  }
}

// The Anthropic model a scheduled run's Managed Agent System runs on, or null when the run's
// Schedule uses an external agent or a dataset Connection (nothing to meter as managed spend).
async function managedAgentTargetModel(scheduleId: string): Promise<string | null> {
  const { data: schedule, error: schedErr } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- claim path has no AuthContext: scoped by the claimed run's schedule id (#207 scope boundary)
    .from("schedules")
    .select("connection_id")
    .eq("id", scheduleId)
    .maybeSingle();
  if (schedErr) throw schedErr;
  if (!schedule?.connection_id) return null;

  const { data: conn, error: connErr } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- claim path has no AuthContext: scoped by the schedule's connection id (#207 scope boundary)
    .from("connections")
    .select("agent_kind, target_model")
    .eq("id", schedule.connection_id)
    .maybeSingle();
  if (connErr) throw connErr;
  return conn?.agent_kind === "managed" ? (conn.target_model as string | null) : null;
}
