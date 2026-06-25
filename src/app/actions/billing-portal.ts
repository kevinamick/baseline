"use server";

import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { getPortalConfigurationId } from "@/lib/billing/portal-config";
import { track } from "@/lib/analytics/server";
import { redirect } from "next/navigation";

/**
 * Open the Stripe Customer Portal for the caller's active Team (#191). The
 * Team is taken from the verified auth context — never from the client — and
 * only Contributors may manage billing (same gate as checkout). The portal
 * configuration is restricted to payment method, billing details, and invoice
 * history; cancellation and plan changes stay in-app (S5).
 *
 * Fails closed: a Team without a Stripe customer (Free, never subscribed) has
 * nothing to manage — the billing page doesn't render the button for them, and
 * a forged submit still dies here.
 */
export async function openBillingPortal(): Promise<void> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) throw new Error("Not signed in");
  if (!canWrite) throw new Error("Only contributors can manage billing");

  const { data: customer, error: customerErr } = await supabaseAdmin
    .from("customers")
    .select("stripe_customer_id")
    .eq("org_id", orgId)
    .maybeSingle();

  if (customerErr) throw customerErr;

  if (!customer?.stripe_customer_id) {
    throw new Error("This team has no billing account yet");
  }

  const configuration = await getPortalConfigurationId();

  await track(
    { name: "billing.portal_opened", props: { team_id: orgId } },
    { userId }
  );

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    configuration,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/billing`,
  });

  redirect(session.url);
}
