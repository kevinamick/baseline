"use server";

import { getAuthContext } from "@/lib/auth/context";
import { isTeamAdmin } from "@/lib/auth/teams";
import { isPaidPlanSlug, priceIdForPlan } from "@/lib/billing/plans";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { track } from "@/lib/analytics/server";

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

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: orgId,
    subscription_data: { metadata: { org_id: orgId } },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=cancel`,
  });

  redirect(session.url!);
}
