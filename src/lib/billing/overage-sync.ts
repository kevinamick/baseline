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
 */

interface DirtyLine {
  period_start: string;
  meter: OverageMeter;
  quantity: number;
  stripe_invoice_item_id: string | null;
}

/**
 * Push settled-overage lines to Stripe as invoice items — quantity × the
 * plan's unit rate, one item per (period, meter), idempotent via the stored
 * invoice-item id. Items are pending by default (they attach to the period's
 * renewal invoice when Stripe creates it); `invoiceId` targets a specific
 * draft invoice — the `invoice.created` webhook backstop, so lines settled
 * but never pushed during the period still land on the renewal invoice.
 *
 * Never throws: invoicing lags must not fail runs or page loads. A line stays
 * dirty until a push succeeds, and `dirty=false` is only written when the
 * quantity is still the one that was pushed.
 */
export async function syncOverageInvoiceItems(
  orgId: string,
  opts: { invoiceId?: string } = {}
): Promise<void> {
  try {
    const { data: lines } = await supabaseAdmin
      .from("overage_invoice_lines")
      .select("period_start, meter, quantity, stripe_invoice_item_id")
      .eq("org_id", orgId)
      .eq("dirty", true);
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
    if (!customer?.stripe_customer_id || !rates) {
      await log.warn("overage push skipped — no customer or no overage rates", {
        event: "billing.overage_push_skipped",
        org_id: orgId,
      });
      return;
    }

    for (const line of lines as DirtyLine[]) {
      const unitUsd =
        line.meter === "points" ? rates.pointUnitUsd : rates.runUnitUsd;
      const label = line.meter === "points" ? "Eval Point" : "Optimization Run";
      const periodLabel = new Date(line.period_start).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      try {
        let itemId = line.stripe_invoice_item_id;
        if (itemId) {
          await stripe.invoiceItems.update(itemId, { quantity: line.quantity });
        } else if (line.quantity > 0) {
          const item = await stripe.invoiceItems.create({
            customer: customer.stripe_customer_id,
            currency: "usd",
            quantity: line.quantity,
            // Cents, decimal — fractional cents are how a $0.0005 point rate
            // is expressed.
            unit_amount_decimal: Stripe.Decimal.from((unitUsd * 100).toFixed(6)),
            description: `${label} overage — period starting ${periodLabel}`,
            ...(opts.invoiceId ? { invoice: opts.invoiceId } : {}),
          });
          itemId = item.id;
        } else {
          // Nothing pushed and nothing to push (a line that grew and shrank
          // back to zero between syncs).
          itemId = null;
        }
        // Clear dirty only if the quantity is still the one we pushed — a
        // concurrent settle that bumped it keeps the line dirty for the next
        // sync.
        await supabaseAdmin
          .from("overage_invoice_lines")
          .update({ stripe_invoice_item_id: itemId, dirty: false })
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
  } catch (err) {
    await log.error("overage invoice sync failed", {
      event: "billing.overage_sync_failed",
      org_id: orgId,
      error: err,
    });
  }
}