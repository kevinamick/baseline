import { log } from "@/lib/logging/server";
import {
  retentionCandidateOrgs,
  sweepRetentionForOrg,
} from "@/lib/billing/retention";

/**
 * Internal trigger for retention-window aging (#187, ADR-0008).
 *
 * The pg_cron sweep (`tick_retention`) pokes this daily when any Team holds live
 * runs; the plan's Retention Window is a code constant (PLANS[plan].retentionDays),
 * so the DB just wakes us and this route does the authoritative, code-side cutoff
 * per org and soft-deletes anything past it. Steady-state, silent aging — the loud
 * downgrade cliff (with the Contributor email) is driven separately from the
 * Stripe webhook. Idempotent: an already-soft-deleted run is skipped, so re-POSTs
 * (cron overlap, manual trigger, retries) are safe.
 *
 * Authenticated by a shared bearer secret (the value the cron config carries).
 * Fails closed: no secret configured → 503; wrong/absent header → 401.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RETENTION_SECRET;
  if (!secret) {
    return new Response("Not configured", { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const orgIds = await retentionCandidateOrgs();
  // Sequential: aging is a low-volume daily pass and each sweep never throws, so
  // there's no need to fan out.
  for (const orgId of orgIds) {
    await sweepRetentionForOrg(orgId);
  }

  await log.info("retention sweep processed", {
    event: "billing.retention_swept",
    org_count: orgIds.length,
  });

  return Response.json({ swept: orgIds.length });
}
