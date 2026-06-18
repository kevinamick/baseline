import "server-only";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import { getBillingState } from "@/lib/billing/state";
import {
  PLANS,
  type PlanSlug,
  trustCeilingUsd,
  nextTrustTier,
} from "@/lib/billing/plans";

/**
 * Trust escalation server seam (#188, ADR-0008). The trust ceiling — the most a
 * Team may raise its Managed Spend Cap to — is derived from its paid-invoice
 * history (the paid_invoices mirror) against the code-side escalation schedule.
 * The webhook feeds the mirror; the cap-setting action reads getTrustStatus and
 * blocks raises above the ceiling.
 *
 * The mirror counts only UN-REVERSED invoices, so a refund, dispute, void, or
 * uncollectible mark never advances trust — under-counting is the safe direction
 * (a missed paid invoice merely delays a raise), so the webhook helpers below are
 * best-effort and never fail the webhook over a trust write.
 */

export interface TrustStatus {
  plan: PlanSlug;
  /** Count of paid, un-reversed invoices for this Team. */
  paidInvoices: number;
  /** Highest cap the Team may self-raise to, or null when managed spend is N/A. */
  ceilingUsd: number | null;
  /** The plan default cap (the first-tier ceiling), or null when N/A. */
  defaultCapUsd: number | null;
  /** The next tier the Team would unlock by paying more invoices, if any. */
  nextTier: { atPaidInvoices: number; ceilingUsd: number } | null;
}

/** Count of paid, un-reversed invoices for one Team (the trust signal). */
export async function getPaidInvoiceCount(orgId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("paid_invoices")
    .select("stripe_invoice_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .is("reversed_at", null);
  if (error) {
    // Fail closed on the trust signal: an unreadable history means "no trust
    // built", which clamps the ceiling to the plan default rather than waving a
    // raise through on a transient read error.
    await log.error("paid invoice count read failed", {
      event: "billing.trust_count_failed",
      org_id: orgId,
      error,
    });
    return 0;
  }
  return count ?? 0;
}

/** The Team's full trust posture: plan, history, ceiling, and next tier. */
export async function getTrustStatus(orgId: string): Promise<TrustStatus> {
  const [{ plan }, paidInvoices] = await Promise.all([
    getBillingState(orgId),
    getPaidInvoiceCount(orgId),
  ]);
  return {
    plan,
    paidInvoices,
    ceilingUsd: trustCeilingUsd(plan, paidInvoices),
    defaultCapUsd: PLANS[plan].defaultManagedSpendCapUsd,
    nextTier: nextTrustTier(plan, paidInvoices),
  };
}

/**
 * Record a paid invoice for a Team. Idempotent on the invoice id (Stripe delivers
 * at-least-once), so a replay never double-counts. An invoice we already marked
 * reversed stays reversed — paying again can't happen, and we never resurrect it.
 */
async function recordPaidInvoice(
  orgId: string,
  invoiceId: string,
  paidAtIso: string,
  amountUsd: number,
  paymentIntentId: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("paid_invoices")
    .upsert(
      {
        stripe_invoice_id: invoiceId,
        org_id: orgId,
        paid_at: paidAtIso,
        amount_usd: amountUsd,
        stripe_payment_intent_id: paymentIntentId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_invoice_id", ignoreDuplicates: true },
    );
  if (error) {
    await log.error("paid invoice record failed", {
      event: "billing.trust_record_failed",
      org_id: orgId,
      stripe_invoice_id: invoiceId,
      error,
    });
  }
}

type ReversalReason = "refund" | "dispute" | "uncollectible" | "void";

/**
 * Mark a previously-paid invoice reversed so it no longer counts toward trust.
 * Located by invoice id (void / uncollectible carry it) or by payment intent
 * (refund / dispute name only a charge / payment intent, never our invoice id).
 * A no-op if we never recorded the invoice, or it's already reversed (first reason
 * wins — a dispute after a refund keeps the refund stamp). Best-effort.
 */
async function reversePaidInvoice(
  by: { invoiceId: string } | { paymentIntentId: string },
  reason: ReversalReason,
): Promise<void> {
  const base = supabaseAdmin
    .from("paid_invoices")
    .update({
      reversed_at: new Date().toISOString(),
      reversal_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .is("reversed_at", null);
  const { error } =
    "invoiceId" in by
      ? await base.eq("stripe_invoice_id", by.invoiceId)
      : await base.eq("stripe_payment_intent_id", by.paymentIntentId);
  if (error) {
    await log.error("paid invoice reversal failed", {
      event: "billing.trust_reverse_failed",
      reversal_reason: reason,
      locator: by,
      error,
    });
  }
}

/** The id behind a Stripe ref that may be a string id or an expanded object. */
function refId(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** The PI id from an invoice's payments list, if a PaymentIntent settled it. */
function paymentIntentFromList(invoice: Stripe.Invoice): string | null {
  // Find the payment that carries a PI: a "payment_intent"-type payment has one,
  // a "charge"-type payment doesn't — so match on the PI's presence rather than
  // reading [0] blindly (which could land on a charge-type payment and miss it).
  const payment = invoice.payments?.data?.find((p) => p.payment.payment_intent)
    ?.payment;
  return payment ? refId(payment.payment_intent) : null;
}

/**
 * The PaymentIntent that settled an invoice, captured at record time so a later
 * refund / dispute (which name only a charge / PI, never our invoice id) can find
 * the row to reverse. MUST be captured reliably — a missed PI strands a
 * chargeback's trust (the row never reverses → over-counting).
 *
 * Stripe's webhook payload omits the `payments` sub-list (it's an un-expanded
 * ApiList), so the inline read usually comes back empty: fall back to re-fetching
 * the invoice with it expanded. Best-effort — null only when Stripe genuinely
 * surfaces no PI (e.g. a non-PI payment method); such an invoice can still be
 * reversed by the invoice-keyed void / uncollectible events.
 */
async function invoicePaymentIntentId(
  invoice: Stripe.Invoice,
): Promise<string | null> {
  const inline = paymentIntentFromList(invoice);
  if (inline || !invoice.id) return inline;
  try {
    const full = await stripe.invoices.retrieve(invoice.id, {
      expand: ["payments.data.payment.payment_intent"],
    });
    return paymentIntentFromList(full);
  } catch (err) {
    await log.error("invoice payment-intent lookup failed", {
      event: "billing.trust_pi_lookup_failed",
      stripe_invoice_id: invoice.id,
      error: err,
    });
    return null;
  }
}

/** Resolve the Team that owns a Stripe customer, or null if unmirrored. */
async function orgForCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): Promise<string | null> {
  const customerId = typeof customer === "string" ? customer : customer?.id;
  if (!customerId) return null;
  const { data } = await supabaseAdmin
    .from("customers")
    .select("org_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.org_id ?? null;
}

/**
 * Feed the trust mirror from a verified Stripe event (#188). Handles every event
 * that changes a Team's paid-invoice history: a paid invoice records (advancing
 * trust), a refund / dispute / void / uncollectible reverses (never advancing it).
 *
 * Called from the webhook route as a best-effort side effect — it NEVER throws, so
 * a trust-accounting hiccup can't fail (and force Stripe to retry) an otherwise
 * good webhook. Idempotent, so the route can call it before deduping the event.
 * Returns whether it recognised the event type (for the route's logging only).
 */
export async function applyTrustWebhook(event: Stripe.Event): Promise<boolean> {
  try {
    switch (event.type) {
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        if (!invoice.id) return true;
        // Trust is proof of a real payment (ADR-0008: the card is charged upfront).
        // A $0 invoice (100%-off coupon / trial) proves no card, so it never
        // advances the ceiling — only a positively-settled invoice counts.
        const amountUsd = (invoice.amount_paid ?? invoice.amount_due ?? 0) / 100;
        if (amountUsd <= 0) return true;
        const orgId = await orgForCustomer(invoice.customer);
        if (!orgId) return true;
        await recordPaidInvoice(
          orgId,
          invoice.id,
          new Date(event.created * 1000).toISOString(),
          amountUsd,
          await invoicePaymentIntentId(invoice),
        );
        return true;
      }

      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        // These carry the invoice id, so reverse by it directly.
        const invoice = event.data.object as Stripe.Invoice;
        if (!invoice.id) return true;
        await reversePaidInvoice(
          { invoiceId: invoice.id },
          event.type === "invoice.voided" ? "void" : "uncollectible",
        );
        return true;
      }

      case "charge.refunded": {
        // A refund names only its charge; reverse via the charge's payment intent,
        // the linkage we captured when the invoice was recorded paid (dahlia
        // decoupled charges from invoices, so there's no charge.invoice anymore).
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = refId(charge.payment_intent);
        if (paymentIntentId) {
          await reversePaidInvoice({ paymentIntentId }, "refund");
        }
        return true;
      }

      case "charge.dispute.created": {
        // A chargeback must NOT let a Team keep the trust the disputed invoice
        // bought. The dispute carries its payment intent directly — match the row
        // by it (no extra API call).
        const dispute = event.data.object as Stripe.Dispute;
        const paymentIntentId = refId(dispute.payment_intent);
        if (paymentIntentId) {
          await reversePaidInvoice({ paymentIntentId }, "dispute");
        }
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    await log.error("trust webhook side-effect failed", {
      event: "billing.trust_webhook_failed",
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      error: err,
    });
    return false;
  }
}
