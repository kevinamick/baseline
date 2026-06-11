import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { mirrorActionForEvent } from "@/lib/billing/webhook";

const UNIQUE_VIOLATION = "23505";

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

  // Idempotency: Stripe delivers at-least-once. If we've already recorded this
  // event id, it's a replay — acknowledge without re-applying (ADR-0008). The
  // ledger row is written only after a successful apply below, so a mid-failure
  // retry (500, not yet recorded) reprocesses; the mutations are idempotent.
  const { data: seen } = await supabaseAdmin
    .from("billing_events")
    .select("stripe_event_id")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (seen) {
    await log.info("stripe webhook replay ignored", {
      event: "stripe.webhook_replay_ignored",
      stripe_event_id: event.id,
      stripe_event_type: event.type,
    });
    return new Response(null, { status: 200 });
  }

  const action = mirrorActionForEvent(event);

  if (action.kind === "invalid") {
    await log.error("stripe webhook event missing identifiers", {
      event: "stripe.webhook_invalid_event",
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      reason: action.reason,
    });
    return new Response("Missing identifiers", { status: 400 });
  }

  if (action.kind !== "noop") {
    const patch = { ...action.patch, updated_at: new Date().toISOString() };
    const { error } =
      action.kind === "upsert"
        ? await supabaseAdmin
            .from("customers")
            .upsert(patch, { onConflict: "org_id" })
        : await supabaseAdmin
            .from("customers")
            .update(patch)
            .eq("stripe_customer_id", action.customerId);

    if (error) {
      await log.error("customer mirror write failed", {
        event: "stripe.customer_mirror_failed",
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        error,
      });
      // 500 → Stripe retries; event not yet recorded, so the retry reprocesses.
      return new Response("Database error", { status: 500 });
    }

    if (event.type === "checkout.session.completed" && action.kind === "upsert") {
      const subId = action.patch.stripe_subscription_id;
      if (subId) {
        await track(
          {
            name: "billing.subscription_started",
            props: {
              team_id: action.orgId,
              stripe_subscription_id: subId,
              stripe_customer_id: action.patch.stripe_customer_id!,
            },
          },
          { userId: null, requestId: req.headers.get("x-request-id") }
        );
      }
    }
  }

  // Record the processed event last, so only a fully-applied event is deduped.
  // A concurrent duplicate may race past the seen-check above; the unique PK
  // turns the loser's insert into a harmless conflict, and the mutation it
  // already ran was idempotent.
  const { error: ledgerError } = await supabaseAdmin
    .from("billing_events")
    .insert({ stripe_event_id: event.id, type: event.type });
  if (ledgerError && ledgerError.code !== UNIQUE_VIOLATION) {
    await log.error("billing event ledger write failed", {
      event: "stripe.billing_event_ledger_failed",
      stripe_event_id: event.id,
      error: ledgerError,
    });
  }

  await log.info("stripe webhook processed", {
    event: "stripe.webhook_processed",
    stripe_event_id: event.id,
    stripe_event_type: event.type,
    livemode: event.livemode,
  });

  return new Response(null, { status: 200 });
}
