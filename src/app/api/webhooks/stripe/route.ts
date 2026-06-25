import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { mirrorActionForEvent } from "@/lib/billing/webhook";
import { isActiveStatus, isEndedStatus } from "@/lib/billing/state";
import { countMembers } from "@/lib/billing/seats";
import { syncOverageInvoiceItems } from "@/lib/billing/overage-sync";
import { PLANS, planForPriceId } from "@/lib/billing/plans";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { notifyManagedPaymentFailed } from "@/lib/billing/managed-spend";
import { applyRetentionForPlanChange } from "@/lib/billing/retention";
import { applyTrustWebhook } from "@/lib/billing/trust";
import { seatCapEmailHtml } from "@/lib/email/templates/seat-cap";

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
  const { data: seen, error: seenError } = await supabaseAdmin
    .from("billing_events")
    .select("stripe_event_id")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (seenError) {
    // Idempotency check failed — log and proceed. Mutations below are idempotent,
    // and the final billing_events insert handles any duplicate with UNIQUE_VIOLATION.
    await log.error("billing_events idempotency check failed — proceeding with reprocessing", {
      event: "stripe.webhook_idempotency_check_failed",
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      error: seenError,
    });
  } else if (seen) {
    await log.info("stripe webhook replay ignored", {
      event: "stripe.webhook_replay_ignored",
      stripe_event_id: event.id,
      stripe_event_type: event.type,
    });
    return new Response(null, { status: 200 });
  }

  // Trust escalation (#188): feed the paid-invoice mirror that backs each Team's
  // trust ceiling. Done up front — before the customer-mirror logic and its
  // early-returns (e.g. the managed-recovery id mismatch) — so a paid invoice
  // always advances trust regardless of how the mirror branch resolves. Idempotent
  // and best-effort: it never throws, so it can't fail (and force Stripe to retry)
  // an otherwise good webhook, and a re-run on a 500-retry path is safe.
  await applyTrustWebhook(event);

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
    // Load the current mirror row (by whichever key this action uses) for the
    // recency + identity guards below.
    const mirrorCols =
      "org_id, stripe_customer_id, stripe_price_id, mirror_event_at, schedule_event_at, managed_failed_invoice_id";
    const { data: existing, error: existingError } = await (action.kind === "upsert"
      ? supabaseAdmin.from("customers").select(mirrorCols).eq("org_id", action.orgId)
      : supabaseAdmin.from("customers").select(mirrorCols).eq("stripe_customer_id", action.customerId)
    ).maybeSingle();
    if (existingError) {
      await log.error("mirror row lookup failed — retrying", {
        event: "stripe.webhook_mirror_lookup_failed",
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        error: existingError,
      });
      return new Response("Mirror lookup failed", { status: 500 });
    }

    // Managed-token recovery (#186) must clear the block only for the SAME
    // invoice that set it — paying a different managed invoice must not lift a
    // block another decline is holding. The pure mapper can't read the mirror, so
    // the id match happens here; on a mismatch we acknowledge and skip the clear.
    if (
      action.kind === "update_by_customer" &&
      action.patch.managed_payment_failed_at === null &&
      existing?.managed_failed_invoice_id != null &&
      existing.managed_failed_invoice_id !== (event.data.object as Stripe.Invoice).id
    ) {
      await log.info("managed invoice paid for a different invoice — block held", {
        event: "stripe.managed_recovery_mismatch",
        stripe_event_id: event.id,
      });
      return new Response(null, { status: 200 });
    }

    // update_by_customer (invoice/subscription-without-metadata) can only touch a
    // row checkout already created. If it's missing, the event arrived out of
    // order — 500 so Stripe redelivers until the row exists, rather than silently
    // dropping a state change (e.g. a lost past_due).
    if (action.kind === "update_by_customer" && !existing) {
      await log.warn("mirror update for unknown customer; awaiting checkout", {
        event: "stripe.customer_mirror_missing_row",
        stripe_event_id: event.id,
        stripe_event_type: event.type,
      });
      return new Response("Customer not yet mirrored", { status: 500 });
    }

    // Identity guard: a status event whose Team (org_id) is already bound to a
    // *different* Stripe customer is a metadata-hijack attempt — refuse it.
    if (
      action.kind === "upsert" &&
      existing?.stripe_customer_id &&
      action.patch.stripe_customer_id &&
      existing.stripe_customer_id !== action.patch.stripe_customer_id
    ) {
      await log.error("mirror customer id mismatch for org; refusing", {
        event: "stripe.customer_mirror_id_mismatch",
        stripe_event_id: event.id,
        org_id: action.orgId,
      });
      return new Response("Customer/org mismatch", { status: 400 });
    }

    // Recency guard applies only to status-bearing events (subscription.*,
    // invoice.payment_failed). checkout.session.completed carries no status and
    // only links ids/email, so it is never stale and never advances the marker —
    // letting it set the marker could starve a near-simultaneous subscription
    // event with an earlier `created`. Schedule events guard against their own
    // marker (schedule_event_at): the pending fields are written only by them,
    // and a late `updated` must not resurrect a pending change that a
    // `released` (keepPlan) already cleared.
    const isStatusEvent = action.patch.status !== undefined;
    const isScheduleEvent = event.type.startsWith("subscription_schedule.");
    const eventCreatedIso = new Date(event.created * 1000).toISOString();
    const stale =
      (isStatusEvent &&
        existing?.mirror_event_at != null &&
        eventCreatedIso < existing.mirror_event_at) ||
      (isScheduleEvent &&
        existing?.schedule_event_at != null &&
        eventCreatedIso < existing.schedule_event_at);

    if (stale) {
      await log.info("stale stripe event ignored (out of order)", {
        event: "stripe.webhook_stale_event_ignored",
        stripe_event_id: event.id,
        stripe_event_type: event.type,
      });
    } else {
      const orgId = action.kind === "upsert" ? action.orgId : existing?.org_id ?? null;

      // Retention window on a plan change (#187): when an active subscription event
      // moves the Team to a plan with a different Retention Window, reconcile run
      // history. A downgrade (smaller window) bulk-soft-deletes the now-out-of-window
      // runs and emails Contributors the count + purge date; a re-upgrade restores
      // anything back inside the window not yet purged.
      //
      // Run BEFORE the mirror write — and so before any 500-capable step — so the
      // old/new decision is reliable across redeliveries. `existing.stripe_price_id`
      // is the OLD price until the write below commits; if a later step 500s (or the
      // process dies after the write) and Stripe retries, a hook placed AFTER the
      // write would re-read the already-mirrored new price, read old == new, and skip
      // the one-shot cliff (losing the email) for good. Here the worst case is a
      // re-run on retry, which is safe: the soft-delete skips already-stamped rows and
      // notifyLimitOnce throttles the email once per period. Never throws; a soft
      // delete is reversible and only purges after a 30-day grace, so even an
      // ultimately-unwritten mirror destroys nothing.
      if (
        orgId &&
        isStatusEvent &&
        isActiveStatus(action.patch.status) &&
        action.patch.stripe_price_id
      ) {
        const oldPlan = planForPriceId(existing?.stripe_price_id ?? null);
        const newPlan = planForPriceId(action.patch.stripe_price_id);
        if (oldPlan && newPlan && oldPlan !== newPlan) {
          await applyRetentionForPlanChange(
            orgId,
            oldPlan,
            newPlan,
            action.patch.current_period_start ?? eventCreatedIso,
          );
        }
      }

      const patch = {
        ...action.patch,
        ...(isStatusEvent ? { mirror_event_at: eventCreatedIso } : {}),
        ...(isScheduleEvent ? { schedule_event_at: eventCreatedIso } : {}),
        updated_at: new Date().toISOString(),
      };
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

      // Plan-grant reconciliation (#182): whenever an actively-paid subscription
      // is mirrored, bring the period's granted totals up to the plan in force —
      // the lazy grant on a fresh period, an 'upgrade' delta after a mid-period
      // upgrade. Idempotent; mid-period downgrades never claw back.
      if (
        orgId &&
        isStatusEvent &&
        isActiveStatus(action.patch.status) &&
        action.patch.stripe_price_id &&
        action.patch.current_period_start &&
        action.patch.current_period_end
      ) {
        const plan = planForPriceId(action.patch.stripe_price_id);
        if (plan) {
          const { error: reconcileError } = await supabaseAdmin.rpc("reconcile_plan_grants", {
            p_org_id: orgId,
            p_period_start: action.patch.current_period_start,
            p_period_end: action.patch.current_period_end,
            p_included_points: PLANS[plan].includedEvalPoints,
            p_included_runs: PLANS[plan].includedOptimizationRuns,
          });
          if (reconcileError) {
            await log.error("plan grant reconciliation failed", {
              event: "stripe.grant_reconcile_failed",
              stripe_event_id: event.id,
              org_id: orgId,
              error: reconcileError,
            });
            // 500 → Stripe retries; everything up to here is idempotent.
            return new Response("Database error", { status: 500 });
          }
        }
      }

      // Cancellation executed (#182): the execution-time re-check. Runs are
      // already refused live by the seat gate; this is the Contributor email.
      if (orgId && isStatusEvent && isEndedStatus(action.patch.status)) {
        const count = await countMembers(orgId);
        const seatLimit = PLANS.free.seatLimit ?? 1;
        if (count > seatLimit) {
          await notifyLimitOnce({
            orgId,
            kind: "seat_cap_violation",
            // Keyed on the subscription's final period, not the event time:
            // `updated(status=canceled)` and `deleted` both report the ending,
            // and per-event keys would email the admins once per event.
            periodStart: action.patch.current_period_start ?? eventCreatedIso,
            subject: (teamName) => `${teamName} has more members than the Free plan allows`,
            html: (teamName, billingUrl) =>
              seatCapEmailHtml({
                teamName,
                memberCount: count,
                seatLimit,
                billingUrl,
              }),
          });
        }
      }

      // Managed-token payment failed (#186): the fail-closed flag was just set —
      // email Contributors that managed runs are paused (BYO + subscription
      // unaffected). Recovery is automatic on the next invoice.paid. Throttled
      // once per period via billing_notifications.
      if (orgId && action.patch.managed_payment_failed_at != null) {
        const invoice = event.data.object as Stripe.Invoice;
        const amountUsd = (invoice.amount_due ?? 0) / 100;
        const periodStart = invoice.metadata?.period_start ?? eventCreatedIso;
        await notifyManagedPaymentFailed(orgId, amountUsd, periodStart);
      }
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

  // Overage backstop (#183): when the period's renewal invoice drafts, push
  // any settled-overage lines that never synced during the period, targeted
  // at the draft so they land on THIS invoice (a plain pending item created
  // now would only attach to the next one). Never fails the webhook.
  if (event.type === "invoice.created") {
    const invoice = event.data.object as Stripe.Invoice;
    const invoiceCustomer =
      typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (invoice.billing_reason === "subscription_cycle" && invoiceCustomer) {
      const { data: row, error: rowError } = await supabaseAdmin
        .from("customers")
        .select("org_id")
        .eq("stripe_customer_id", invoiceCustomer)
        .maybeSingle();
      if (rowError) {
        await log.error("invoice.created customer lookup failed — overage sync skipped", {
          event: "stripe.overage_sync_customer_lookup_failed",
          stripe_event_id: event.id,
          stripe_customer_id: invoiceCustomer,
          error: rowError,
        });
      } else if (row?.org_id) {
        await syncOverageInvoiceItems(row.org_id, {
          invoiceId: invoice.id,
          invoiceCreatedAt: invoice.created,
        });
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
