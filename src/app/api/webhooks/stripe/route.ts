import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      raw,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    // Fire-and-forget on purpose: this path is reachable by ANY unauthenticated POST,
    // so it must never buy an attacker a synchronous PostHog round-trip per request.
    // (log.warn never rejects; the console mirror still happens synchronously.)
    void log.warn("stripe webhook signature verification failed", {
      event: "stripe.webhook_signature_invalid",
      error: err,
    });
    return new Response(`Webhook Error: ${msg}`, { status: 400 });
  }

  // INFO boundary logs are best-effort by design (info-level log.* doesn't await the
  // OTLP flush), so these awaits cost no network round-trip; only the error paths
  // below block — bounded — on shipping the record.
  await log.info("stripe webhook received", {
    event: "stripe.webhook_received",
    stripe_event_id: event.id,
    stripe_event_type: event.type,
    livemode: event.livemode,
  });

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // client_reference_id is the Supabase user id (set by checkout.ts from the
    // auth seam), so it already exists in public.users via the sign-up trigger.
    const userId = session.client_reference_id;
    const stripeCustomerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;
    const stripeSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;

    if (!userId || !stripeCustomerId) {
      await log.error("checkout.session.completed missing identifiers", {
        event: "stripe.checkout_missing_identifiers",
        stripe_event_id: event.id,
        user_id: userId,
        stripe_customer_id: stripeCustomerId,
      });
      return new Response("Missing identifiers", { status: 400 });
    }

    const { error } = await supabaseAdmin.from("customers").upsert(
      {
        user_id: userId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        email: session.customer_email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) {
      await log.error("Supabase upsert failed", {
        event: "stripe.customer_upsert_failed",
        stripe_event_id: event.id,
        error,
      });
      return new Response("Database error", { status: 500 });
    }

    if (stripeSubscriptionId) {
      await track(
        {
          name: "billing.subscription_started",
          props: {
            user_id: userId,
            stripe_subscription_id: stripeSubscriptionId,
            stripe_customer_id: stripeCustomerId,
          },
        },
        { userId, requestId: req.headers.get("x-request-id") }
      );
    }
  }

  await log.info("stripe webhook processed", {
    event: "stripe.webhook_processed",
    stripe_event_id: event.id,
    stripe_event_type: event.type,
    livemode: event.livemode,
  });

  return new Response(null, { status: 200 });
}
