import { log } from "@/lib/logging/server";
import { requireInternalSecret } from "@/lib/auth/internal-secret";
import {
  orgsWithUninvoicedManagedSpend,
  syncManagedInvoiceLines,
} from "@/lib/billing/managed-invoice-sync";

/**
 * Internal trigger for managed-token threshold billing (#186, ADR-0008 Meter 2).
 *
 * The pg_cron sweep (`tick_managed_threshold`) pokes this once a minute when any
 * Team carries un-invoiced managed spend; Stripe lives app-side only (never in the
 * DB or the worker), so the DB just wakes us and this route does the authoritative,
 * code-side billing decision per org (threshold-reached or period-ended →
 * create+finalize a charge-now invoice). Idempotent: Stripe idempotency keys plus
 * the invoiced-watermark bookkeeping make re-POSTs (cron vs manual, retries) safe.
 *
 * Authenticated by a shared bearer secret (the value the cron config carries).
 * Fails closed: no secret configured → 503; wrong/absent header → 401.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireInternalSecret(req, "MANAGED_THRESHOLD_SECRET", "billing.managed_threshold");
  if (denied) return denied;

  const orgIds = await orgsWithUninvoicedManagedSpend();
  // Sequential: invoicing is rare, low-volume, and each org does Stripe network
  // I/O — no need to fan out and risk rate limits. Each call never throws.
  for (const orgId of orgIds) {
    await syncManagedInvoiceLines(orgId);
  }

  await log.info("managed threshold sweep processed", {
    event: "billing.managed_threshold_swept",
    org_count: orgIds.length,
  });

  return Response.json({ swept: orgIds.length });
}
