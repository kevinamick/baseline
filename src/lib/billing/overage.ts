import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { notifyBillingLimit, NOTIFICATION_KIND } from "@/lib/billing/limit-notifications";

/**
 * Opt-in Overage Caps (#183, ADR-0008). One dollar cap per Team covers both
 * platform meters; a negative ledger balance IS the overage, priced at the
 * plan's per-point / per-run rates. The SQL reserve functions are the only
 * enforcement point — everything here is reads, projections, and emails. The
 * Stripe push of settled overage lives in overage-sync.ts, so the reserve
 * path never loads the Stripe client. Off by default: no billing_settings
 * row (or a null cap) means hard stop, exactly the pre-#183 behavior.
 */

/**
 * Overage meters. Platform overage is now a SINGLE points meter (ADR-0016):
 * Eval Run cost and Optimization Run overage both draw Eval Points. "runs" is
 * retained only so historical `overage_invoice_lines` rows (settled under the
 * pre-ADR-0016 flat per-run model) still read and label; no new run-overage
 * line is ever produced.
 */
export const OVERAGE_METERS = ["points", "runs"] as const;
export type OverageMeter = (typeof OVERAGE_METERS)[number];

export interface OverageRates {
  pointUnitUsd: number;
}

/** A plan's overage rate, or null when the plan has no overage option. */
export function overageRatesForPlan(plan: PlanSlug): OverageRates | null {
  const def = PLANS[plan];
  if (def.evalPointOverageUsd == null) {
    return null;
  }
  return {
    pointUnitUsd: def.evalPointOverageUsd,
  };
}

/** The Team's cap in dollars, or null when overage is off. */
export async function getOverageCap(orgId: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from("billing_settings")
    .select("overage_cap_usd")
    .eq("org_id", orgId)
    .maybeSingle();
  const cap = data?.overage_cap_usd;
  return cap == null ? null : Number(cap);
}

/**
 * Committed overage in dollars for the given point balance — the same math as
 * the SQL `projected_overage_usd`, for pre-checks, warnings, and display. The
 * SQL function remains the only authority at reserve time. Optimization overage
 * is points too (ADR-0016), so the point balance is the whole story.
 */
export function projectedOverageUsd(
  pointBalance: number,
  rates: OverageRates
): number {
  return Math.max(0, -pointBalance) * rates.pointUnitUsd;
}

/** Warning threshold: Contributors hear about it at 80% of the cap. */
export const OVERAGE_WARNING_RATIO = 0.8;

/**
 * The cap-reached email, throttled once per period — one wording for both
 * meters, owned here so the two run-start actions can't drift.
 */
export async function notifyCapReached(
  orgId: string,
  capUsd: number,
  periodStart: string
): Promise<void> {
  await notifyBillingLimit(NOTIFICATION_KIND.overageLimit, orgId, periodStart, { capUsd });
}

/**
 * After a successful cap-backed reserve: if committed overage has crossed the
 * warning threshold, email the Contributors (once per period — the
 * billing_notifications PK throttles). Never throws; a warning email must not
 * fail the run that triggered it.
 */
export async function maybeWarnNearCap(
  orgId: string,
  opts: { capUsd: number; plan: PlanSlug; periodStart: string }
): Promise<void> {
  try {
    const rates = overageRatesForPlan(opts.plan);
    if (!rates) return;
    const points = await supabaseAdmin.rpc("point_balance", {
      p_org_id: orgId,
      p_period_start: opts.periodStart,
    });
    const committedUsd = projectedOverageUsd(Number(points.data ?? 0), rates);
    if (committedUsd < OVERAGE_WARNING_RATIO * opts.capUsd) return;

    await notifyBillingLimit(NOTIFICATION_KIND.overageWarning, orgId, opts.periodStart, {
      committedUsd,
      capUsd: opts.capUsd,
    });
  } catch (err) {
    await log.error("overage warning check failed", {
      event: "billing.overage_warning_failed",
      org_id: orgId,
      error: err,
    });
  }
}

/** True when any line is awaiting a push — the page-load sync precondition. */
export async function hasDirtyOverageLines(orgId: string): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from("overage_invoice_lines")
    .select("org_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("dirty", true);
  return (count ?? 0) > 0;
}

