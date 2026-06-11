import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

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
 * Raw Stripe subscription statuses. Single source of truth: the access decision
 * derives from this list, never from scattered string literals.
 * (active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired,
 * paused — Stripe's full set as of the pinned API version.)
 */
export const ACTIVE_STATUSES = ["active", "trialing"] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export interface BillingState {
  /** True when the Team may use paid functionality. Fail-closed default. */
  active: boolean;
  /** Raw Stripe subscription status, or null when no mirror row exists. */
  status: string | null;
  /** The subscribed Stripe price id (plan identity until #179 names it). */
  priceId: string | null;
  currentPeriodEnd: string | null;
}

const BLOCKED: BillingState = {
  active: false,
  status: null,
  priceId: null,
  currentPeriodEnd: null,
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
    .select("status, stripe_price_id, current_period_end")
    .eq("org_id", orgId)
    .maybeSingle();

  if (!data) return BLOCKED;

  return {
    active: isActiveStatus(data.status),
    status: data.status ?? null,
    priceId: data.stripe_price_id ?? null,
    currentPeriodEnd: data.current_period_end ?? null,
  };
}
