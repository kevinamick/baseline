import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSeatCapState } from "@/lib/billing/seats";
import { evalRunPointCost, evalRunPointsPerRow } from "@/lib/billing/points";
import { reserveEvalRunPoints, resolvePointPeriod } from "@/lib/billing/ledger";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { notifyCapReached } from "@/lib/billing/overage";
import { pointsLimitEmailHtml } from "@/lib/email/templates/points-limit";
import { seatCapEmailHtml } from "@/lib/email/templates/seat-cap";
import { resolveKeyModeForEstimate, KEY_MODE } from "@/lib/llm/key-gate";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import {
  getEffectiveManagedCap,
  reserveManagedSpend,
  notifyManagedCapReached,
} from "@/lib/billing/managed-spend";
import { ESTIMATE_JUDGE_MODEL, ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";
import { PLANS } from "@/lib/billing/plans";

/**
 * Claim-time billing gate for SCHEDULE-spawned eval runs (#199).
 *
 * tick_schedules() inserts scheduled eval_runs directly in SQL with no Point
 * reserve and no seat-cap check, so a Team that's blocked interactively (Free
 * quota exhausted, or over the seat cap after an executed downgrade) would keep
 * producing runs every tick, unmetered. Interactive runs are already gated at
 * creation (createEvalRun) — this closes the schedule hole at the only other
 * place the run's cost is knowable: worker claim time, once the rows exist
 * (tick copies tabular inputs; the worker fetches dataset rows before this runs).
 *
 * The worker can't import this (separate package), so it reaches it through the
 * internal `/api/internal/claim-reserve` route, which is a thin auth wrapper over
 * this function. Reusing the app's exact reserve/seat/period/plan logic keeps the
 * scheduled path identical to the interactive one — no constant or period-math
 * duplication.
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

export async function gateScheduledRunBilling(runId: string): Promise<ClaimGateResult> {
  const { data: run } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubric_id, schedule_id")
    .eq("id", runId)
    .maybeSingle();
  if (!run?.rubric_id) return { allowed: true };

  // Already reserved (interactive run, or a redelivered claim) → no double charge.
  const { data: existingReserve } = await supabaseAdmin
    .from("point_ledger")
    .select("id")
    .eq("eval_run_id", runId)
    .eq("entry_type", "reserve")
    .limit(1)
    .maybeSingle();
  if (existingReserve) return { allowed: true };

  const { data: rubric } = await supabaseAdmin
    .from("rubrics")
    .select("org_id, criteria")
    .eq("id", run.rubric_id)
    .maybeSingle();
  if (!rubric?.org_id) return { allowed: true };
  const orgId = rubric.org_id as string;

  // The billing period start — for the seat-cap notification's once-per-period
  // throttle. billing_notifications.period_start is a timestamptz, so this must be
  // a real timestamp (a synthetic key would fail the upsert and silently drop the
  // email). The reserve below resolves the same period internally.
  const period = await resolvePointPeriod(orgId);
  const periodStart = period.start.toISOString();

  // Seat-cap gate (#182): an ended subscription left the Team over the Free cap.
  const seats = await getSeatCapState(orgId);
  if (seats.violated) {
    await notifyLimitOnce({
      orgId,
      kind: "seat_cap",
      periodStart,
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
  const { count } = await supabaseAdmin
    .from("eval_run_rows")
    .select("row_index", { count: "exact", head: true })
    .eq("eval_run_id", runId);
  const rowCount = count ?? 0;
  const criteriaCount = Array.isArray(rubric.criteria) ? rubric.criteria.length : 0;
  const cost = evalRunPointCost(rowCount, criteriaCount);

  const reservation = await reserveEvalRunPoints(orgId, runId, cost, {
    row_count: rowCount,
    criteria_count: criteriaCount,
    per_row_cost: evalRunPointsPerRow(criteriaCount),
  });
  if (!reservation.reserved) {
    // Mirror createEvalRun's notification choice: a failing card was already
    // surfaced (#186/#215), a cap wall sends the cap email, else the points email.
    if (!reservation.paymentFailing) {
      const remaining = Math.max(0, reservation.balance);
      if (reservation.capUsd != null) {
        await notifyCapReached(orgId, reservation.capUsd, reservation.periodStart);
      } else {
        await notifyLimitOnce({
          orgId,
          kind: "points_limit",
          periodStart: reservation.periodStart,
          subject: (teamName) => `${teamName} has hit its Eval Point limit`,
          html: (teamName, billingUrl) =>
            pointsLimitEmailHtml({
              teamName,
              neededPoints: cost,
              remainingPoints: remaining,
              billingUrl,
            }),
        });
      }
    }
    return { allowed: false, reason: "insufficient_points" };
  }

  // Managed Agent spend reserve (#292). A scheduled run whose System is a Managed Agent runs the
  // target model on the managed key — the dominant managed-spend term — so reserve it (plus the
  // judge term) against the Managed Spend Cap here, mirroring the interactive path (createEvalRun),
  // before the worker invokes it. Only managed-AGENT runs reserve here: external-agent and dataset
  // scheduled runs are untouched (unchanged), and a BYO/Free Team resolves to byo/blocked and
  // skips (the worker runs BYO unmetered; a Free managed-agent schedule is refused at creation).
  const targetModel = run.schedule_id ? await managedAgentTargetModel(run.schedule_id) : null;
  if (targetModel) {
    // Managed Agents are paid-plan only (#292). Refuse a Free/unpaid Team even with a BYO key: a
    // schedule created while paid keeps ticking after a downgrade, and resolve-key → byo wouldn't
    // otherwise stop it. This also catches a trialing/unrecognized-price org that floors to Free
    // here while the worker's key resolver still sees an "active" status — without this, that run
    // would reach the worker, resolve to the managed key, find no reservation, and run uncapped.
    // (managedMarkupPct == null ⇔ Free; mirrors createSchedule.)
    if (PLANS[reservation.plan].managedMarkupPct == null) {
      return { allowed: false, reason: "managed_not_paid" };
    }
    const keyMode = await resolveKeyModeForEstimate(orgId, ESTIMATE_JUDGE_PROVIDER);
    if (keyMode === KEY_MODE.managed) {
      const judgeEst =
        estimateManagedSpendUsd(
          reservation.plan,
          ESTIMATE_JUDGE_PROVIDER,
          ESTIMATE_JUDGE_MODEL,
          rowCount,
          criteriaCount
        ) ?? 0;
      const targetEst =
        estimateManagedSpendUsd(reservation.plan, ESTIMATE_JUDGE_PROVIDER, targetModel, rowCount, 1) ??
        0;
      const estimate = judgeEst + targetEst;
      const { capUsd } = await getEffectiveManagedCap(orgId);
      const markupPct = PLANS[reservation.plan].managedMarkupPct;
      if (estimate > 0 && capUsd != null && markupPct != null) {
        const { reserved } = await reserveManagedSpend(
          orgId,
          { evalRunId: runId },
          estimate,
          capUsd,
          markupPct,
          { start: reservation.periodStart, end: reservation.periodEnd }
        );
        if (!reserved) {
          // The point reserve above is released when the worker marks this run failed
          // (settle_eval_run_points on 'failed'); nothing to roll back here.
          await notifyManagedCapReached(orgId, capUsd, reservation.periodStart);
          return { allowed: false, reason: "managed_cap" };
        }
      }
    }
  }

  return { allowed: true };
}

// The Anthropic model a scheduled run's Managed Agent System runs on, or null when the run's
// Schedule uses an external agent or a dataset Connection (nothing to meter as managed spend).
async function managedAgentTargetModel(scheduleId: string): Promise<string | null> {
  const { data: schedule } = await supabaseAdmin
    .from("schedules")
    .select("connection_id")
    .eq("id", scheduleId)
    .maybeSingle();
  if (!schedule?.connection_id) return null;

  const { data: conn } = await supabaseAdmin
    .from("connections")
    .select("agent_kind, target_model")
    .eq("id", schedule.connection_id)
    .maybeSingle();
  return conn?.agent_kind === "managed" ? (conn.target_model as string | null) : null;
}
