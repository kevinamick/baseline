"use server";

import { createTranslator } from "next-intl";
import { getTranslations } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { isTeamAdmin } from "@/lib/auth/teams";
import { isPaidPlanSlug, priceIdForPlan } from "@/lib/billing/plans";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { track } from "@/lib/analytics/server";
import { evaluateAndConsumeAccessCodeBenefit } from "@/lib/access-codes/checkout-benefit";
import enMessages from "../../../messages/en.json";

/**
 * The trial billing disclosure (#449): a trial waives the subscription fee
 * only — managed-key model usage still bills to the card as it's used, from
 * day one. `custom_text.submit.message` puts that statement on the Checkout
 * page itself, right where the card is collected, so it's never
 * tooltip/hover-only. Rendered in the caller's request locale when available;
 * falls back to the English catalog string outside a request scope (mirrors
 * `localizeRunGateError` in `src/lib/billing/run-gate.ts`), which is also
 * exactly what every non-en-request checkout gets today since Stripe
 * Checkout itself doesn't yet localize past this one string.
 */
async function trialDisclosureMessage(): Promise<string> {
  try {
    const t = await getTranslations("Billing.trialDisclosure");
    return t("message");
  } catch {
    return createTranslator({
      locale: "en",
      messages: enMessages,
      namespace: "Billing.trialDisclosure",
    })("message");
  }
}

/**
 * Start a Stripe Checkout session for a Team (ADR-0007: the Team is the billing
 * subject). The orgId is bound by the caller (e.g. the active Team's id from a
 * form), so it is *verified server-side* against the caller's memberships — only
 * a Contributor of that exact Team may subscribe it. A forged or foreign org id
 * has no matching admin membership and is rejected before any Stripe call.
 *
 * The plan slug selects the price *server-side* (priceIdForPlan) — the client
 * never supplies a Stripe price id, so it can't subscribe a Team to an arbitrary
 * or cheaper price. An unknown slug (or Free, which has no checkout) is rejected.
 *
 * The Team id rides through Stripe two ways so the webhook can mirror state back
 * regardless of event ordering: as `client_reference_id` on the session, and as
 * `org_id` metadata on the subscription (subscription.* events carry only the
 * subscription, not the session).
 *
 * Every checkout (this Team's first or its fifth, after churn-and-resubscribe)
 * runs `evaluateAndConsumeAccessCodeBenefit` (ADR-0017 slice 3, #427, extended
 * for coupons in slice 4, #428): the one-shot guarantee lives in that call's
 * atomic consume, not here, so this action doesn't need to know whether it's
 * "the first checkout" — a Team whose bound redemption was already consumed
 * simply gets no benefit again. A granted trial rides
 * `subscription_data.trial_period_days`; a granted coupon rides `discounts`
 * (Baseline performs no discount math — Stripe owns percent/duration/
 * proration and the invoice line, per ADR-0008's mirror discipline). The two
 * compose freely on one checkout since they're independent Stripe params.
 * Stripe's default payment-method collection is left untouched, so a card is
 * still required during the trial (ADR-0008's "paid access has a billable
 * card").
 */
export async function createCheckoutSession(orgId: string, plan: string) {
  const { userId } = await getAuthContext();
  if (!userId) throw new Error("Not signed in");

  if (!isPaidPlanSlug(plan)) {
    throw new Error(`Not a subscribable plan: ${plan}`);
  }

  if (!(await isTeamAdmin(orgId, userId))) {
    throw new Error("Not authorized to subscribe this Team");
  }

  const priceId = priceIdForPlan(plan);
  const requestId = (await headers()).get("x-request-id");

  await track(
    {
      name: "billing.checkout_started",
      props: { team_id: orgId, plan, price_id: priceId },
    },
    { userId, requestId }
  );

  const { trialPeriodDays, stripeCouponId } =
    await evaluateAndConsumeAccessCodeBenefit(orgId, plan);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: orgId,
    subscription_data: {
      metadata: { org_id: orgId },
      ...(trialPeriodDays != null
        ? { trial_period_days: trialPeriodDays }
        : {}),
    },
    ...(stripeCouponId != null
      ? { discounts: [{ coupon: stripeCouponId }] }
      : {}),
    // #449: only a trial checkout carries the disclosure — a no-trial
    // checkout is a plain immediate charge with nothing extra to state here.
    ...(trialPeriodDays != null
      ? { custom_text: { submit: { message: await trialDisclosureMessage() } } }
      : {}),
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?checkout=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=cancel`,
  });

  redirect(session.url!);
}
