import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import { isPlanSlug, type PlanSlug } from "@/lib/billing/plans";
import {
  describeCoupon,
  couponBenefitDescriptor,
  type CouponBenefitDescriptor,
} from "./coupon-summary";

/**
 * Read-only counterpart to `evaluateAndConsumeAccessCodeBenefit`
 * (ADR-0017 slice 4, #428): powers the billing page's "you have a pending
 * benefit" notice, which must be able to look at a Team's unconsumed grant
 * WITHOUT consuming it — checking in on a benefit can't be the thing that
 * spends it. Same lookup shape as the consuming function's step 1
 * (`checkout-benefit.ts`), no `.update()` ever runs here.
 */
export interface PendingAccessCodeBenefit {
  trialDays: number | null;
  stripeCouponId: string | null;
  planSlug: PlanSlug | null;
}

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
 * Looks up the Team's unconsumed Access Code redemption grant, if any. Never
 * throws: a lookup error fails closed (null, i.e. "nothing to show") rather
 * than breaking the page it's rendered on, and is logged.
 */
export async function getPendingAccessCodeBenefit(
  orgId: string
): Promise<PendingAccessCodeBenefit | null> {
  const { data, error } = await supabaseAdmin
    .from("access_code_redemptions")
    .select("id, access_codes(trial_days, stripe_coupon_id, plan_slug)")
    .eq("org_id", orgId)
    .is("benefit_consumed_at", null)
    .maybeSingle();

  if (error) {
    await log.error("access code pending benefit lookup failed", {
      event: "access_code.pending_benefit_lookup_failed",
      org_id: orgId,
      error,
    });
    return null;
  }

  const redemption = data as RedemptionCandidateRow | null;
  if (!redemption) return null; // never bound, or already consumed

  const code = Array.isArray(redemption.access_codes)
    ? redemption.access_codes[0]
    : redemption.access_codes;
  if (!code) return null;

  return {
    trialDays: code.trial_days,
    stripeCouponId: code.stripe_coupon_id,
    planSlug: isPlanSlug(code.plan_slug) ? code.plan_slug : null,
  };
}

/** The billing/pricing page's ready-to-render shape of a pending benefit. */
export interface PendingBenefitView {
  trialDays: number | null;
  planSlug: PlanSlug | null;
  coupon: CouponBenefitDescriptor | null;
}

/**
 * Composes the read-only lookup above with the coupon's display shape
 * (`describeCoupon`) into the view the billing page renders, or null when
 * there's genuinely nothing to show — including a redemption that exists but
 * carries neither `trial_days` nor `stripe_coupon_id` (a gate-pass-only code,
 * the common case while ADR-0017's sign-up gate is up: most codes carry no
 * billing benefit at all, so a bound redemption is not on its own a reason
 * to render a notice).
 */
export async function getPendingAccessCodeBenefitView(
  orgId: string
): Promise<PendingBenefitView | null> {
  const pending = await getPendingAccessCodeBenefit(orgId);
  if (!pending) return null;
  if (pending.trialDays == null && pending.stripeCouponId == null) return null;

  const summary = pending.stripeCouponId
    ? await describeCoupon(pending.stripeCouponId)
    : null;
  const coupon = summary ? couponBenefitDescriptor(summary) : null;

  // A coupon id that failed to resolve (retired coupon, Stripe hiccup) AND no
  // trial to fall back on leaves nothing worth showing.
  if (pending.trialDays == null && coupon == null) return null;

  return { trialDays: pending.trialDays, planSlug: pending.planSlug, coupon };
}
