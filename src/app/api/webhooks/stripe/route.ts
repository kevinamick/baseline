import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";

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
    return new Response(`Webhook Error: ${msg}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    const clerkUserId = session.client_reference_id;
    const stripeCustomerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;
    const stripeSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;

    if (!clerkUserId || !stripeCustomerId) {
      console.error("checkout.session.completed missing identifiers", {
        eventId: event.id,
        clerkUserId,
        stripeCustomerId,
      });
      return new Response("Missing identifiers", { status: 400 });
    }

    const { error: userError } = await supabaseAdmin
      .from("users")
      .upsert({ id: clerkUserId }, { onConflict: "id", ignoreDuplicates: true });

    if (userError) {
      console.error("Supabase users upsert failed", { eventId: event.id, error: userError });
      return new Response("Database error", { status: 500 });
    }

    const { error } = await supabaseAdmin.from("customers").upsert(
      {
        clerk_user_id: clerkUserId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        email: session.customer_email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "clerk_user_id" }
    );

    if (error) {
      console.error("Supabase upsert failed", { eventId: event.id, error });
      return new Response("Database error", { status: 500 });
    }

    if (stripeSubscriptionId) {
      await track(
        {
          name: "billing.subscription_started",
          props: {
            user_id: clerkUserId,
            stripe_subscription_id: stripeSubscriptionId,
            stripe_customer_id: stripeCustomerId,
          },
        },
        { userId: clerkUserId, requestId: req.headers.get("x-request-id") }
      );
    }
  }

  return new Response(null, { status: 200 });
}
