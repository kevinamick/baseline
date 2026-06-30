import "server-only";
import { firstRow } from "@/lib/supabase/first-row";
import { rpcOrThrow } from "@/lib/supabase/rpc";
import { PLANS, planForPriceId, type PlanSlug } from "@/lib/billing/plans";
import { getBillingState, isEndedStatus } from "@/lib/billing/state";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { retentionDowngradeEmailHtml } from "@/lib/email/templates/retention-downgrade";
import { log } from "@/lib/logging/server";

/**
 * Retention Window enforcement (#187, ADR-0008). Runs older than the plan's window
 * are soft-deleted (hidden everywhere); a scheduled job purges them 30 days later.
 * The window is a CODE constant (PLANS[plan].retentionDays), so — like threshold
 * billing (#186) — the authoritative decision lives here, app-side, and the SQL
 * acts only on an app-supplied cutoff. Two callers drive the soft-delete:
 *   - the daily aging sweep (sweepRetentionForOrg, via the internal route), steady
 *     state and silent;
 *   - a plan change that shrinks the window (applyRetentionForPlanChange, from the
 *     webhook), the "loud" downgrade cliff that also emails Contributors.
 * Re-upgrading restores everything back inside the (larger) window not yet purged.
 */

/** Days between soft-deletion and permanent purge (ADR-0008). */
export const RETENTION_GRACE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The window cutoff: a run created before this instant is out of the window.
 * Pure — the single place window math happens, unit-testable without a clock.
 */
export function retentionCutoffIso(retentionDays: number, nowMs: number): string {
  return new Date(nowMs - retentionDays * DAY_MS).toISOString();
}

/** When data soft-deleted at nowMs will be purged. Pure. */
export function purgeDateIso(nowMs: number, graceDays = RETENTION_GRACE_DAYS): string {
  return new Date(nowMs + graceDays * DAY_MS).toISOString();
}

/** A plan change is a retention downgrade when the new window is smaller. Pure. */
export function isRetentionDowngrade(oldDays: number, newDays: number): boolean {
  return newDays < oldDays;
}

/**
 * Purge-eligibility predicate, mirroring the SQL invariant in purge_expired_runs:
 * only rows soft-deleted at least grace days ago are eligible — never live
 * (deletedAt null) and never recently-soft-deleted data. Pure, for unit coverage.
 */
export function isPurgeEligible(
  deletedAtMs: number | null,
  nowMs: number,
  graceDays = RETENTION_GRACE_DAYS,
): boolean {
  return deletedAtMs != null && deletedAtMs < nowMs - graceDays * DAY_MS;
}

interface ExpireCounts {
  evalExpired: number;
  optExpired: number;
}

/** Soft-delete an org's live runs created before the cutoff. Returns the counts. */
async function expireRunsBefore(
  orgId: string,
  cutoffIso: string,
): Promise<ExpireCounts> {
  const data = await rpcOrThrow("expire_runs_before", {
    p_org_id: orgId,
    p_cutoff: cutoffIso,
  });
  const row = firstRow(data);
  return {
    evalExpired: Number(row?.eval_expired ?? 0),
    optExpired: Number(row?.opt_expired ?? 0),
  };
}

/** Restore an org's soft-deleted runs that are back inside the window. */
async function restoreRunsSince(orgId: string, cutoffIso: string): Promise<void> {
  await rpcOrThrow("restore_runs_since", {
    p_org_id: orgId,
    p_cutoff: cutoffIso,
  });
}

/** Orgs holding any live run — the aging sweep's candidate set. */
export async function retentionCandidateOrgs(): Promise<string[]> {
  const data = await rpcOrThrow<unknown[] | null>("retention_candidate_orgs");
  // SETOF uuid arrives as an array of scalars or {retention_candidate_orgs} rows
  // depending on PostgREST; normalise both.
  return (data ?? []).map((r: unknown) =>
    typeof r === "string"
      ? r
      : (r as { retention_candidate_orgs: string }).retention_candidate_orgs,
  );
}

/**
 * Steady-state aging for one org: soft-delete everything past the plan's window.
 * Silent (no email) — this is the boundary moving by a day, not a cliff. Never
 * throws: the sweep route processes many orgs and one bad org must not abort it.
 */
export async function sweepRetentionForOrg(orgId: string, nowMs = Date.now()): Promise<void> {
  try {
    // Retention follows the SUBSCRIBED plan, not the quota floor. getBillingState
    // floors `plan` to free on any non-active status — but payment trouble
    // (past_due/unpaid) is a live subscription, and ADR-0008 forbids shrinking
    // retention as a side effect of a payment failure. Only a genuinely-ended
    // subscription (canceled) drops to the Free window. No mirror → priceId null →
    // free, the always-available baseline.
    const { status, priceId } = await getBillingState(orgId);
    const plan = isEndedStatus(status) ? "free" : planForPriceId(priceId) ?? "free";
    const cutoff = retentionCutoffIso(PLANS[plan].retentionDays, nowMs);
    await expireRunsBefore(orgId, cutoff);
  } catch (err) {
    await log.error("retention sweep failed for org", {
      event: "billing.retention_sweep_failed",
      org_id: orgId,
      error: err,
    });
  }
}

/**
 * React to a plan change's effect on the retention window. A SHRINK (downgrade
 * cliff) bulk-soft-deletes the now-out-of-window history and emails Contributors
 * the count + purge date. A GROW (re-upgrade) restores everything back inside the
 * window not yet purged. Equal windows are a no-op. Never throws — the webhook's
 * exactly-once mirror write must not depend on this best-effort side effect, and
 * the daily sweep is the backstop for the soft-delete.
 */
export async function applyRetentionForPlanChange(
  orgId: string,
  oldPlan: PlanSlug,
  newPlan: PlanSlug,
  periodStart: string,
  nowMs = Date.now(),
): Promise<void> {
  try {
    const oldDays = PLANS[oldPlan].retentionDays;
    const newDays = PLANS[newPlan].retentionDays;
    const cutoff = retentionCutoffIso(newDays, nowMs);

    if (isRetentionDowngrade(oldDays, newDays)) {
      const { evalExpired, optExpired } = await expireRunsBefore(orgId, cutoff);
      const total = evalExpired + optExpired;
      if (total > 0) {
        await notifyLimitOnce({
          orgId,
          kind: "retention_downgrade",
          periodStart,
          subject: (teamName) =>
            `${teamName}: ${total} ${total === 1 ? "run" : "runs"} moved out of your retention window`,
          html: (teamName, billingUrl) =>
            retentionDowngradeEmailHtml({
              teamName,
              planName: PLANS[newPlan].name,
              retentionDays: newDays,
              runCount: total,
              purgeDateIso: purgeDateIso(nowMs),
              billingUrl,
            }),
        });
      }
    } else if (newDays > oldDays) {
      await restoreRunsSince(orgId, cutoff);
    }
  } catch (err) {
    await log.error("retention plan-change handling failed", {
      event: "billing.retention_plan_change_failed",
      org_id: orgId,
      error: err,
    });
  }
}
