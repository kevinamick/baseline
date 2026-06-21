import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBillingState, isEndedStatus } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";

/** The one definition of a Team's seat usage — every cap check counts here. */
export async function countMembers(orgId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId);
  return count ?? 0;
}

/**
 * Seat-cap enforcement (#182, ADR-0007: seat limits are Team limits). Billing
 * never removes members — a Team over its plan's cap is blocked from starting
 * runs until membership fits or the plan grows. Computed live from the
 * memberships table, so the execution-time re-check needs no stored flag.
 *
 * Scope: the violation is the ENDED-SUBSCRIPTION state (ENDED_STATUSES) — the
 * subscription went away while the Team still exceeded the Free cap, exactly
 * the case the schedule-time wall could not prevent (re-inviting during the
 * notice period). Teams that have always been Free (no mirror row) predate
 * seat billing and are grandfathered; their cap is enforced at the source
 * instead — invites are blocked at the limit.
 */
export interface SeatCapState {
  /** True when an ended subscription left the Team over the Free seat cap. */
  violated: boolean;
  memberCount: number;
  /** null = unlimited. */
  seatLimit: number | null;
}

/** The one user-facing wording for a seat-cap refusal, varied only by verb. */
export function seatCapError(seats: SeatCapState, action: string): string {
  return `Your team has ${seats.memberCount} members but the current plan includes ${seats.seatLimit} — remove members or upgrade to ${action}.`;
}

export async function getSeatCapState(orgId: string): Promise<SeatCapState> {
  const [billing, memberCount] = await Promise.all([
    getBillingState(orgId),
    countMembers(orgId),
  ]);
  const seatLimit = PLANS[billing.plan].seatLimit;
  return {
    violated:
      isEndedStatus(billing.status) && seatLimit != null && memberCount > seatLimit,
    memberCount,
    seatLimit,
  };
}
