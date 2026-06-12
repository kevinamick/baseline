import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { planForPriceId, type PlanSlug } from "@/lib/billing/plans";

/**
 * Billing state for a Team, derived from the local mirror of Stripe subscription
 * state (ADR-0008) — never from a live Stripe API call. The mirror is kept fresh
 * by the webhook; this is the single seam every billing-gated read flows through.
 *
 * Resolution fails closed: a Team with no mirror row, or one whose subscription
 * is anything other than actively-paid, is `blocked`. New access-granting states
 * must be added explicitly to ACTIVE_STATUSES — the default is always "blocked".
 */

/**
 * The Stripe subscription statuses that grant access — the single source of
 * truth for the access decision, never scattered string literals. Everything
 * else in Stripe's set (past_due, canceled, unpaid, incomplete,
 * incomplete_expired, paused) is blocked by the fail-closed default. `trialing`
 * grants access during a trial before a payment is captured (intended).
 */
export const ACTIVE_STATUSES = ["active", "trialing"] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export interface BillingState {
  /** True when the Team may use *paid* functionality. Fail-closed default. */
  active: boolean;
  /**
   * The Team's effective plan. A Team with an active paid subscription is on
   * that plan; everything else — no subscription, or a non-active one — floors
   * to "free", the always-available baseline. So `active` gates paid features
   * while `plan` names the quota tier in force.
   */
  plan: PlanSlug;
  /** Raw Stripe subscription status, or null when no mirror row exists. */
  status: string | null;
  /** The subscribed Stripe price id, or null. */
  priceId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** Cancellation scheduled for period end (#182) — reversible until then. */
  cancelAtPeriodEnd: boolean;
  /** A scheduled paid→paid downgrade (#182): the price taking over, and when. */
  pendingPriceId: string | null;
  pendingChangeAt: string | null;
}

const BLOCKED: BillingState = {
  active: false,
  plan: "free",
  status: null,
  priceId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pendingPriceId: null,
  pendingChangeAt: null,
};

/** Classify a raw status. Anything not explicitly active-granting is blocked. */
export function isActiveStatus(status: string | null | undefined): boolean {
  return (
    status != null && (ACTIVE_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Resolve a Team's billing state from the mirror. A null orgId, a missing row,
 * or a non-active subscription all collapse to the same blocked state — callers
 * never get a free pass from absent or stale data.
 */
export async function getBillingState(
  orgId: string | null
): Promise<BillingState> {
  if (!orgId) return BLOCKED;

  const { data } = await supabaseAdmin
    .from("customers")
    .select(
      "status, stripe_price_id, current_period_start, current_period_end, cancel_at_period_end, pending_price_id, pending_change_at"
    )
    .eq("org_id", orgId)
    .maybeSingle();

  if (!data) return BLOCKED;

  const active = isActiveStatus(data.status);
  // Plan in force = the paid plan only while the subscription is active;
  // otherwise the Free floor. An unrecognised (retired) price also floors.
  const plan = active ? planForPriceId(data.stripe_price_id) ?? "free" : "free";

  return {
    active,
    plan,
    status: data.status ?? null,
    priceId: data.stripe_price_id ?? null,
    currentPeriodStart: data.current_period_start ?? null,
    currentPeriodEnd: data.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
    pendingPriceId: data.pending_price_id ?? null,
    pendingChangeAt: data.pending_change_at ?? null,
  };
}
