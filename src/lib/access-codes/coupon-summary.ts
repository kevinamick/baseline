import "server-only";
import { stripe } from "@/lib/stripe";
import { log } from "@/lib/logging/server";

/**
 * A coupon's DISPLAY shape (ADR-0017 slice 4, #428) — read from Stripe purely
 * to describe a pending Access Code grant in copy ("50% off for 3 months").
 * This is never used for money math: the checkout itself only ever passes
 * the coupon id through `discounts` (`checkout-benefit.ts` /
 * `src/app/actions/checkout.ts`), and Stripe alone computes the percent/
 * duration/proration that lands on the invoice (ADR-0008's mirror
 * discipline). A coupon may additionally carry Stripe `applies_to` product
 * scoping, set in the Stripe Dashboard when the coupon is created — Baseline
 * doesn't read or reflect that scoping here, it's between Stripe and the
 * invoice line.
 */
export interface CouponSummary {
  percentOff: number | null;
  amountOffUsd: number | null;
  duration: "once" | "repeating" | "forever";
  durationInMonths: number | null;
}

/**
 * Fetches a coupon's display shape by id. Never throws: a lookup failure
 * (retired/deleted coupon, transient Stripe error) fails closed to null so a
 * broken coupon reference degrades to "no notice" rather than breaking the
 * billing/pricing page it's rendered on.
 */
export async function describeCoupon(
  stripeCouponId: string
): Promise<CouponSummary | null> {
  try {
    const coupon = await stripe.coupons.retrieve(stripeCouponId);
    return {
      percentOff: coupon.percent_off ?? null,
      amountOffUsd: coupon.amount_off != null ? coupon.amount_off / 100 : null,
      duration: coupon.duration,
      durationInMonths: coupon.duration_in_months ?? null,
    };
  } catch (error) {
    await log.error("access code coupon lookup failed", {
      event: "access_code.coupon_lookup_failed",
      stripe_coupon_id: stripeCouponId,
      error,
    });
    return null;
  }
}

/**
 * The two i18n-friendly shapes a coupon's benefit can render as (percent-off
 * vs a flat amount-off), each carrying `duration` so the caller picks the
 * matching "once" / "repeating" (N months) / "forever" message key. A coupon
 * with neither `percent_off` nor `amount_off` set (shouldn't happen for a
 * real Stripe coupon, but the API types allow it) has nothing to describe.
 */
export type CouponBenefitDescriptor =
  | {
      kind: "percent";
      percent: number;
      duration: CouponSummary["duration"];
      months: number | null;
    }
  | {
      kind: "amount";
      amountUsd: number;
      duration: CouponSummary["duration"];
      months: number | null;
    };

export function couponBenefitDescriptor(
  summary: CouponSummary
): CouponBenefitDescriptor | null {
  if (summary.percentOff != null) {
    return {
      kind: "percent",
      percent: summary.percentOff,
      duration: summary.duration,
      months: summary.durationInMonths,
    };
  }
  if (summary.amountOffUsd != null) {
    return {
      kind: "amount",
      amountUsd: summary.amountOffUsd,
      duration: summary.duration,
      months: summary.durationInMonths,
    };
  }
  return null;
}

/**
 * The i18n message key (under `Settings.billing.plan.*`) for a benefit
 * descriptor — one of six combinations (percent|amount × once|repeating|
 * forever). Keeping the naming rule here means the page component never
 * hand-assembles a key string.
 */
export function couponBenefitMessageKey(
  descriptor: CouponBenefitDescriptor
): string {
  const base =
    descriptor.kind === "percent"
      ? "pendingBenefitCouponPercent"
      : "pendingBenefitCouponAmount";
  const suffix =
    descriptor.duration === "once"
      ? "Once"
      : descriptor.duration === "forever"
        ? "Forever"
        : "Repeating";
  return `${base}${suffix}`;
}
