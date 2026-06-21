import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSeatCapState } from "@/lib/billing/seats";
import { evalRunPointCost, evalRunPointsPerRow } from "@/lib/billing/points";
import { reserveEvalRunPoints } from "@/lib/billing/ledger";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { notifyCapReached } from "@/lib/billing/overage";
import { pointsLimitEmailHtml } from "@/lib/email/templates/points-limit";
import { seatCapEmailHtml } from "@/lib/email/templates/seat-cap";

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
  | { allowed: false; reason: "seat_cap" | "insufficient_points" };

export async function gateScheduledRunBilling(runId: string): Promise<ClaimGateResult> {
  const { data: run } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubric_id")
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

  // Seat-cap gate (#182): an ended subscription left the Team over the Free cap.
  const seats = await getSeatCapState(orgId);
  if (seats.violated) {
    await notifyLimitOnce({
      orgId,
      kind: "seat_cap",
      // Seat state isn't period-scoped; key the once-throttle to the seat limit so
      // a later membership change re-notifies, but repeated ticks don't.
      periodStart: `seat:${seats.memberCount}/${seats.seatLimit}`,
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

  return { allowed: true };
}
