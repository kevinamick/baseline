import "server-only";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { log } from "@/lib/logging/server";
import { PLANS } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";

/**
 * The Stripe half of #186 (ADR-0008 Meter 2): turn accrued managed-token spend
 * into an itemized, immediately-finalized invoice. Split from managed-spend.ts so
 * the run-start reserve path never loads the Stripe client.
 *
 * Source of truth is the immutable managed_spend_ledger; managed_invoice_lines is
 * the derived mirror (one row per period/provider/model) carrying accrued_usd
 * (ledger truth, markup already baked in) and invoiced_usd (the part already on a
 * FINALIZED invoice). The live invoice covers exactly accrued_usd − invoiced_usd,
 * so accrual continues correctly across each invoice boundary and the watermark
 * never double-bills.
 *
 * Billing decision (per period): bill when un-invoiced spend ≥ the plan's
 * threshold (threshold billing — bounds the credit we extend) OR the period has
 * ended (the month-end flush of any sub-threshold remainder). Both go through one
 * dedicated, charge-now invoice tagged `metadata.kind = managed_tokens` so the
 * webhook can tell it from the subscription's recurring invoice and from overage.
 *
 * Never throws: an invoicing lag must not fail the cron, the route, or a webhook.
 * A line stays dirty until a push succeeds; Stripe idempotency keys make retries
 * (cron vs manual, duplicate deliveries, crash-resume) collapse to one invoice.
 */

// Sub-cent slack so float noise never counts as billable un-invoiced spend.
const EPSILON_USD = 1e-6;

/**
 * The threshold-billing decision for one period (#186). Bill now when un-invoiced
 * accrued spend crosses the plan's threshold (bounding the credit we extend) OR
 * the period has ended (the month-end flush of any sub-threshold remainder).
 * Pure so the trigger logic is unit-testable without Stripe or a database.
 */
export function shouldBillManagedPeriod(
  uninvoicedUsd: number,
  thresholdUsd: number | null,
  periodEnded: boolean,
): boolean {
  if (uninvoicedUsd <= EPSILON_USD) return false;
  if (periodEnded) return true;
  return thresholdUsd != null && uninvoicedUsd >= thresholdUsd;
}

interface ManagedLine {
  org_id: string;
  period_start: string;
  period_end: string;
  provider: string;
  model: string;
  accrued_usd: number;
  invoiced_usd: number;
}

/** Distinct orgs carrying un-invoiced managed spend — the sweep's work list. */
export async function orgsWithUninvoicedManagedSpend(): Promise<string[]> {
  // `dirty` is the single-column proxy for "accrued_usd > invoiced_usd": the flow
  // only clears dirty once a line is fully invoiced, so every line with
  // outstanding spend is dirty. The JS filter confirms the column-to-column
  // condition PostgREST can't express.
  const { data } = await supabaseAdmin
    .from("managed_invoice_lines")
    .select("org_id, accrued_usd, invoiced_usd")
    .eq("dirty", true);

  const orgs = new Set<string>();
  for (const r of data ?? []) {
    if (Number(r.accrued_usd) - Number(r.invoiced_usd) > EPSILON_USD) orgs.add(r.org_id);
  }
  return [...orgs];
}

/**
 * Bill an org's outstanding managed spend, per period, when threshold-reached or
 * the period has ended. Never throws.
 */
export async function syncManagedInvoiceLines(orgId: string): Promise<void> {
  try {
    const { data: rows } = await supabaseAdmin
      .from("managed_invoice_lines")
      .select("org_id, period_start, period_end, provider, model, accrued_usd, invoiced_usd")
      .eq("org_id", orgId)
      .eq("dirty", true);
    if (!rows || rows.length === 0) return;

    const lines: ManagedLine[] = rows
      .map((r) => ({
        org_id: r.org_id,
        period_start: r.period_start,
        period_end: r.period_end,
        provider: r.provider,
        model: r.model,
        accrued_usd: Number(r.accrued_usd),
        invoiced_usd: Number(r.invoiced_usd),
      }))
      .filter((l) => l.accrued_usd - l.invoiced_usd > EPSILON_USD);
    if (lines.length === 0) return;

    const [{ plan }, { data: customer }] = await Promise.all([
      getBillingState(orgId),
      supabaseAdmin
        .from("customers")
        .select("stripe_customer_id")
        .eq("org_id", orgId)
        .maybeSingle(),
    ]);
    if (!customer?.stripe_customer_id) {
      await log.warn("managed invoice push skipped — no Stripe customer", {
        event: "billing.managed_invoice_skipped",
        org_id: orgId,
      });
      return;
    }
    const threshold = PLANS[plan].managedInvoiceThresholdUsd;

    // Group by period; each billable period becomes one charge-now invoice.
    const byPeriod = new Map<string, ManagedLine[]>();
    for (const l of lines) {
      const g = byPeriod.get(l.period_start);
      if (g) g.push(l);
      else byPeriod.set(l.period_start, [l]);
    }

    const now = Date.now();
    for (const [periodStart, periodLines] of byPeriod) {
      const uninvoiced = periodLines.reduce(
        (sum, l) => sum + (l.accrued_usd - l.invoiced_usd),
        0
      );
      const periodEnded = new Date(periodLines[0].period_end).getTime() <= now;
      if (!shouldBillManagedPeriod(uninvoiced, threshold, periodEnded)) continue;

      await invoicePeriod(orgId, customer.stripe_customer_id, periodStart, periodLines);
    }
  } catch (err) {
    await log.error("managed invoice sync failed", {
      event: "billing.managed_invoice_sync_failed",
      org_id: orgId,
      error: err,
    });
  }
}

/**
 * Create one charge-now invoice for a period's outstanding lines, itemized by
 * (provider, model), finalize it, then advance each line's watermark. The invoice
 * is created FIRST (auto_advance:false) and items attach to it explicitly via
 * `invoice:` — never `pending_invoice_items_behavior:'include'`, which would also
 * sweep #183's unrelated pending overage items onto this invoice.
 */
async function invoicePeriod(
  orgId: string,
  customerId: string,
  periodStart: string,
  lines: ManagedLine[]
): Promise<void> {
  const periodLabel = new Date(periodStart).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  // Watermark scope for idempotency: the period's already-invoiced total in
  // whole cents. A retry before the watermark advances reuses the same invoice;
  // a genuine later delta (more spend after this push) gets a fresh key.
  const invoicedCents = Math.round(
    lines.reduce((sum, l) => sum + l.invoiced_usd, 0) * 100
  );

  let invoice: Stripe.Invoice;
  try {
    invoice = await stripe.invoices.create(
      {
        customer: customerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        description: `Managed token usage — period starting ${periodLabel}`,
        metadata: { kind: "managed_tokens", org_id: orgId, period_start: periodStart },
      },
      { idempotencyKey: `mgd-inv1:${orgId}:${periodStart}:${invoicedCents}` }
    );
  } catch (err) {
    await log.error("managed invoice create failed", {
      event: "billing.managed_invoice_create_failed",
      org_id: orgId,
      error: err,
    });
    return; // lines stay dirty; next sweep retries
  }

  // Attach one item per (provider, model) for its un-invoiced amount.
  const billed: Array<{ line: ManagedLine; amount: number; itemId: string }> = [];
  for (const line of lines) {
    const amount = line.accrued_usd - line.invoiced_usd;
    if (amount <= EPSILON_USD) continue;
    try {
      const item = await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: invoice.id,
          currency: "usd",
          quantity: 1,
          // Cents, decimal — managed costs are sub-cent per call; the markup is
          // already baked into accrued_usd.
          unit_amount_decimal: Stripe.Decimal.from((amount * 100).toFixed(6)),
          description: `Managed tokens — ${line.provider}/${line.model} — ${periodLabel}`,
          metadata: { kind: "managed_tokens", org_id: orgId },
        },
        {
          idempotencyKey: `mgd-item1:${orgId}:${periodStart}:${line.provider}:${line.model}:${Math.round(
            line.invoiced_usd * 100
          )}`,
        }
      );
      billed.push({ line, amount, itemId: item.id });
    } catch (err) {
      await log.error("managed invoice item create failed", {
        event: "billing.managed_invoice_item_failed",
        org_id: orgId,
        provider: line.provider,
        model: line.model,
        error: err,
      });
      // Leave its line dirty; the partial invoice still finalizes for the rest.
    }
  }

  if (billed.length === 0) return;

  try {
    // Finalize → with charge_automatically Stripe attempts the card now; success
    // fires invoice.paid, decline fires invoice.payment_failed, both carrying our
    // metadata.kind (the webhook's discriminator).
    await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
  } catch (err) {
    await log.error("managed invoice finalize failed", {
      event: "billing.managed_invoice_finalize_failed",
      org_id: orgId,
      invoice_id: invoice.id,
      error: err,
    });
    return; // watermark NOT advanced; lines stay dirty for the next sweep
  }

  // Advance the watermark only on confirmed finalize. Per line, atomically (a
  // concurrent accrual may have grown accrued_usd; dirty re-arms if so).
  for (const { line, amount, itemId } of billed) {
    const { error } = await supabaseAdmin.rpc("mark_managed_line_invoiced", {
      p_org_id: orgId,
      p_period_start: periodStart,
      p_provider: line.provider,
      p_model: line.model,
      p_amount: amount,
      p_invoice_id: invoice.id,
      p_item_id: itemId,
    });
    if (error) {
      await log.error("managed invoice watermark advance failed", {
        event: "billing.managed_invoice_watermark_failed",
        org_id: orgId,
        invoice_id: invoice.id,
        error,
      });
    }
  }

  await log.info("managed token invoice issued", {
    event: "billing.managed_invoice_issued",
    org_id: orgId,
    invoice_id: invoice.id,
    period_start: periodStart,
    line_count: billed.length,
    amount_usd: billed.reduce((s, b) => s + b.amount, 0),
  });
}
