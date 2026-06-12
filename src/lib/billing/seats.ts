import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";

/**
 * Seat-cap enforcement (#182, ADR-0007: seat limits are Team limits). Billing
 * never removes members — a Team over its plan's cap is blocked from starting
 * runs until membership fits or the plan grows. Computed live from the
 * memberships table, so the execution-time re-check needs no stored flag.
 *
 * Scope: the violation is the EXECUTED-CANCELLATION state — a subscription
 * that ended (status "canceled") while the Team still exceeded the Free cap,
 * exactly the case the schedule-time wall could not prevent (re-inviting
 * during the notice period). Teams that have always been Free (no mirror row)
 * predate seat billing and are grandfathered; their cap is enforced at the
 * source instead — invites are blocked at the limit.
 */
export interface SeatCapState {
  /** True when an ended subscription left the Team over the Free seat cap. */
  violated: boolean;
  memberCount: number;
  /** null = unlimited. */
  seatLimit: number | null;
}

export async function getSeatCapState(orgId: string): Promise<SeatCapState> {
  const [billing, { count }] = await Promise.all([
    getBillingState(orgId),
    supabaseAdmin
      .from("memberships")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", orgId),
  ]);
  const seatLimit = PLANS[billing.plan].seatLimit;
  const memberCount = count ?? 0;
  return {
    violated:
      billing.status === "canceled" && seatLimit != null && memberCount > seatLimit,
    memberCount,
    seatLimit,
  };
}
