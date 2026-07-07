import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";

export interface AccessCodeCheckoutBenefit {
  /**
   * Days to grant as a Stripe trial on this checkout's subscription
   * (`subscription_data.trial_period_days`), or null when no trial applies —
   * either there was nothing to evaluate, or the code's plan restriction
   * didn't match the plan being purchased.
   */
  trialPeriodDays: number | null;
  /**
   * Stripe coupon id to apply via checkout `discounts` (#428), or null on the
   * same "nothing to evaluate, or restriction mismatch" terms as
   * `trialPeriodDays`. A trial and a coupon on one code compose — both ride
   * the same checkout — so both fields are gated by the SAME restriction
   * check below, never evaluated independently.
   */
  stripeCouponId: string | null;
}

const NO_BENEFIT: AccessCodeCheckoutBenefit = {
  trialPeriodDays: null,
  stripeCouponId: null,
};

interface AccessCodeGrantFields {
  trial_days: number | null;
  stripe_coupon_id: string | null;
  plan_slug: string | null;
}

interface RedemptionCandidateRow {
  id: string;
  access_codes: AccessCodeGrantFields | AccessCodeGrantFields[] | null;
}

/**
 * One-shot evaluation of a Team's bound Access Code redemption grant, at its
 * FIRST checkout (ADR-0017 slice 3, #427; see CONTEXT.md's Redemption entry).
 * Called from `createCheckoutSession` (src/app/actions/checkout.ts) on every
 * checkout — including a churned Team's resubscribe — so the one-shot
 * guarantee lives entirely in the atomic consume below, not in the caller:
 *
 *   1. Look up the org's unconsumed redemption (if any) and its code's grant
 *      fields. No row (never bound, or already consumed by an earlier
 *      checkout) → no benefit.
 *   2. Atomically consume it: an UPDATE guarded by
 *      `benefit_consumed_at IS NULL`, the same "guarded write IS the
 *      one-shot guarantee" shape #426's claim_access_code uses for its cap.
 *      Two concurrent checkout attempts for the same Team can each reach
 *      step 1, but only one's UPDATE actually matches a still-null row; the
 *      other gets 0 rows back and returns no benefit.
 *   3. Only a redemption THIS call just consumed evaluates the plan
 *      restriction: null or matching the chosen plan applies `trial_days`
 *      AND `stripe_coupon_id` together; a mismatch still consumed the
 *      redemption in step 2 and forfeits BOTH grants (the notice/warning UI
 *      is #428, which also reads the pending grant read-only — before this
 *      consuming call runs — via `getPendingAccessCodeBenefit`).
 *
 * Never throws: a lookup or consume error fails closed (no benefit) rather
 * than blocking checkout over unrelated bookkeeping, and is logged so an
 * operator can reconcile a stuck redemption by hand.
 */
export async function evaluateAndConsumeAccessCodeBenefit(
  orgId: string,
  planSlug: string
): Promise<AccessCodeCheckoutBenefit> {
  const { data, error } = await supabaseAdmin
    .from("access_code_redemptions")
    .select("id, access_codes(trial_days, stripe_coupon_id, plan_slug)")
    .eq("org_id", orgId)
    .is("benefit_consumed_at", null)
    .maybeSingle();

  if (error) {
    await log.error("access code benefit lookup failed", {
      event: "access_code.benefit_lookup_failed",
      org_id: orgId,
      error,
    });
    return NO_BENEFIT;
  }

  const redemption = data as RedemptionCandidateRow | null;
  if (!redemption) return NO_BENEFIT; // never bound, or already consumed

  const { data: consumed, error: consumeError } = await supabaseAdmin
    .from("access_code_redemptions")
    .update({ benefit_consumed_at: new Date().toISOString() })
    .eq("id", redemption.id)
    .is("benefit_consumed_at", null)
    .select("id");

  if (consumeError) {
    await log.error("access code benefit consume failed", {
      event: "access_code.benefit_consume_failed",
      org_id: orgId,
      error: consumeError,
    });
    return NO_BENEFIT;
  }

  if (!consumed || consumed.length === 0) {
    // Lost the race to a concurrent checkout for the same Team — whichever
    // request's UPDATE landed first already evaluated (or forfeited) it.
    return NO_BENEFIT;
  }

  const code = Array.isArray(redemption.access_codes)
    ? redemption.access_codes[0]
    : redemption.access_codes;
  if (!code) return NO_BENEFIT;

  const restrictionMatches = code.plan_slug == null || code.plan_slug === planSlug;
  return {
    trialPeriodDays: restrictionMatches ? code.trial_days : null,
    stripeCouponId: restrictionMatches ? code.stripe_coupon_id : null,
  };
}
