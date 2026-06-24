import "server-only";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { log } from "@/lib/logging/server";
import { planForPriceId } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";
import { overageRatesForPlan, type OverageMeter } from "@/lib/billing/overage";

/**
 * The Stripe half of #183, split from overage.ts so the reserve path (which
 * every run start imports) never loads the Stripe client.
 *
 * Line bookkeeping invariant: `quantity` is the ledger truth (settled −
 * granted); `invoiced_quantity` is the part already on FINALIZED invoices;
 * the live pending item carries `quantity − invoiced_quantity`. When a draft
 * finalizes under the pending item, its quantity rolls into
 * invoiced_quantity and the item id clears — the next sync opens a fresh
 * pending item for any remainder, on the NEXT invoice. Total billed always
 * converges on `quantity`, never above it.
 */

interface DirtyLine {
  period_start: string;
  meter: OverageMeter;
  quantity: number;
  unit_usd: number | null;
  stripe_invoice_item_id: string | null;
  invoiced_quantity: number;
}

/**
 * Push settled-overage lines to Stripe as invoice items, one live pending
 * item per (period, meter). Concurrency-safe: creates carry an idempotency
 * key derived from the line identity + invoiced_quantity, so racing syncs
 * (page load vs webhook, duplicate webhook deliveries) collapse to one Stripe
 * item; the item id is persisted unconditionally, and `dirty` clears only
 * when the pushed quantity is still current.
 *
 * `invoiceId` targets a specific draft — the `invoice.created` webhook
 * backstop — and applies only to lines from periods that closed (a line for
 * the period that just OPENED must wait for its own renewal invoice).
 *
 * Never throws: invoicing lags must not fail runs, pages, or webhooks. A
 * line stays dirty until a push succeeds.
 */
export async function syncOverageInvoiceItems(
  orgId: string,
  opts: { invoiceId?: string; invoiceCreatedAt?: number } = {}
): Promise<void> {
  try {
    const { data: lines, error: linesError } = await supabaseAdmin
      .from("overage_invoice_lines")
      .select("period_start, meter, quantity, unit_usd, stripe_invoice_item_id, invoiced_quantity")
      .eq("org_id", orgId)
      .eq("dirty", true);
    if (linesError) {
      await log.error("overage lines fetch failed", {
        event: "billing.overage_lines_fetch_failed",
        org_id: orgId,
        error: linesError,
      });
      return;
    }
    if (!lines || lines.length === 0) return;

    const [billing, { data: customer }] = await Promise.all([
      getBillingState(orgId),
      supabaseAdmin
        .from("customers")
        .select("stripe_customer_id")
        .eq("org_id", orgId)
        .maybeSingle(),
    ]);
    const plan = planForPriceId(billing.priceId);
    const rates = plan ? overageRatesForPlan(plan) : null;
    if (!customer?.stripe_customer_id) {
      await log.warn("overage push skipped — no Stripe customer", {
        event: "billing.overage_push_skipped",
        org_id: orgId,
      });
      return;
    }

    await Promise.all(
      (lines as DirtyLine[]).map((line) =>
        pushLine(orgId, customer.stripe_customer_id!, line, rates, opts)
      )
    );
  } catch (err) {
    await log.error("overage invoice sync failed", {
      event: "billing.overage_sync_failed",
      org_id: orgId,
      error: err,
    });
  }
}

async function pushLine(
  orgId: string,
  customerId: string,
  line: DirtyLine,
  currentRates: { pointUnitUsd: number; runUnitUsd: number } | null,
  opts: { invoiceId?: string; invoiceCreatedAt?: number }
): Promise<void> {
  // Price snapshot: first push pins the rate of the plan then in force; later
  // pushes (a delta after the invoice finalized, a late settle after a
  // downgrade) reuse it — the old period's overage bills at the rate it was
  // incurred under, or the cap guarantee breaks.
  const unitUsd =
    line.unit_usd ??
    (line.meter === "points" ? currentRates?.pointUnitUsd : currentRates?.runUnitUsd);
  if (unitUsd == null) {
    await log.warn("overage push skipped — no unit rate (plan has no overage)", {
      event: "billing.overage_push_skipped",
      org_id: orgId,
      meter: line.meter,
    });
    return;
  }

  const pendingTarget = line.quantity - line.invoiced_quantity;
  const label = line.meter === "points" ? "Eval Point" : "Optimization Run";
  const periodLabel = new Date(line.period_start).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  // The backstop's draft is the CLOSING period's invoice; a line whose period
  // started around invoice creation belongs to the next one.
  const targetInvoice =
    opts.invoiceId &&
    opts.invoiceCreatedAt != null &&
    new Date(line.period_start).getTime() < (opts.invoiceCreatedAt - 86_400) * 1000
      ? opts.invoiceId
      : undefined;

  try {
    let itemId = line.stripe_invoice_item_id;
    if (itemId) {
      try {
        await stripe.invoiceItems.update(itemId, { quantity: Math.max(0, pendingTarget) });
      } catch (updateErr) {
        // The usual cause: the item's invoice finalized (its quantity is now
        // billed for good). Confirm by retrieving the item; roll its quantity
        // into invoiced_quantity and clear the id — the next sync opens a
        // fresh pending item for the remainder. A transient failure leaves
        // the line dirty and re-throws to the outer catch.
        const item = await stripe.invoiceItems.retrieve(itemId);
        if (!item.invoice) throw updateErr;
        await supabaseAdmin
          .from("overage_invoice_lines")
          .update({
            invoiced_quantity: line.invoiced_quantity + (item.quantity ?? 0),
            stripe_invoice_item_id: null,
          })
          .eq("org_id", orgId)
          .eq("period_start", line.period_start)
          .eq("meter", line.meter);
        return; // stays dirty; the next sync pushes the remainder
      }
    } else if (pendingTarget > 0) {
      const item = await stripe.invoiceItems.create(
        {
          customer: customerId,
          currency: "usd",
          quantity: pendingTarget,
          // Cents, decimal — fractional cents are how a $0.0005 point rate
          // is expressed.
          unit_amount_decimal: Stripe.Decimal.from((unitUsd * 100).toFixed(6)),
          description: `${label} overage — period starting ${periodLabel}`,
          ...(targetInvoice ? { invoice: targetInvoice } : {}),
        },
        {
          // Collapses racing creates (page load vs webhook backstop vs
          // duplicate webhook delivery) into one Stripe item. Scoped by
          // invoiced_quantity so a legitimate post-finalization delta item
          // gets a fresh key.
          idempotencyKey: `ovg1:${orgId}:${line.period_start}:${line.meter}:${line.invoiced_quantity}`,
        }
      );
      itemId = item.id;
      // Persist the id UNCONDITIONALLY — losing it would orphan a billable
      // Stripe item and double-bill on the next create.
      await supabaseAdmin
        .from("overage_invoice_lines")
        .update({ stripe_invoice_item_id: itemId, unit_usd: unitUsd })
        .eq("org_id", orgId)
        .eq("period_start", line.period_start)
        .eq("meter", line.meter);
    } else if (pendingTarget < 0) {
      // Quantity shrank below what already finalized (an upgrade grant after
      // billing). Nothing to un-bill on Stripe; surface it and stop churning.
      await log.warn("overage line below invoiced quantity — manual credit may be due", {
        event: "billing.overage_line_underwater",
        org_id: orgId,
        meter: line.meter,
        quantity: line.quantity,
        invoiced_quantity: line.invoiced_quantity,
      });
    }
    // Clear dirty only if the quantity is still the one this push reflected —
    // a concurrent settle that bumped it keeps the line dirty for the next
    // sync.
    await supabaseAdmin
      .from("overage_invoice_lines")
      .update({ dirty: false })
      .eq("org_id", orgId)
      .eq("period_start", line.period_start)
      .eq("meter", line.meter)
      .eq("quantity", line.quantity);
  } catch (err) {
    await log.error("overage invoice item push failed", {
      event: "billing.overage_push_failed",
      org_id: orgId,
      meter: line.meter,
      error: err,
    });
  }
}