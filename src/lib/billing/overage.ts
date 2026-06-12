import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { overageWarningEmailHtml } from "@/lib/email/templates/overage-cap";

/**
 * Opt-in Overage Caps (#183, ADR-0008). One dollar cap per Team covers both
 * platform meters; a negative ledger balance IS the overage, priced at the
 * plan's per-point / per-run rates. The SQL reserve functions are the only
 * enforcement point — everything here is reads, projections, and emails. The
 * Stripe push of settled overage lives in overage-sync.ts, so the reserve
 * path never loads the Stripe client. Off by default: no billing_settings
 * row (or a null cap) means hard stop, exactly the pre-#183 behavior.
 */

/** The two platform meters with dollar-priced overage. */
export const OVERAGE_METERS = ["points", "runs"] as const;
export type OverageMeter = (typeof OVERAGE_METERS)[number];

export interface OverageRates {
  pointUnitUsd: number;
  runUnitUsd: number;
}

/** A plan's overage rates, or null when the plan has no overage option. */
export function overageRatesForPlan(plan: PlanSlug): OverageRates | null {
  const def = PLANS[plan];
  if (def.evalPointOverageUsd == null || def.optimizationRunOverageUsd == null) {
    return null;
  }
  return {
    pointUnitUsd: def.evalPointOverageUsd,
    runUnitUsd: def.optimizationRunOverageUsd,
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
 * Committed overage in dollars for the given balances — the same math as the
 * SQL `projected_overage_usd`, for pre-checks, warnings, and display. The SQL
 * function remains the only authority at reserve time.
 */
export function projectedOverageUsd(
  pointBalance: number,
  runBalance: number,
  rates: OverageRates
): number {
  return (
    Math.max(0, -pointBalance) * rates.pointUnitUsd +
    Math.max(0, -runBalance) * rates.runUnitUsd
  );
}

export interface OverageState {
  /** null = overage off. */
  capUsd: number | null;
  /** null = the plan has no overage option (Free, or no active plan). */
  rates: OverageRates | null;
  /** Units past included, committed (reserved + settled). */
  pointsOver: number;
  runsOver: number;
  /** Dollar value of the committed overage at the plan's rates. */
  committedUsd: number;
}

/**
 * The Team's overage posture for the current period, from the two meters'
 * balances (negative = overage). Callers that already hold the balances pass
 * them in; the billing page does.
 */
export async function getOverageState(
  orgId: string,
  balances: { pointBalance: number; runBalance: number; plan: PlanSlug }
): Promise<OverageState> {
  const rates = overageRatesForPlan(balances.plan);
  const capUsd = rates ? await getOverageCap(orgId) : null;
  const pointsOver = Math.max(0, -balances.pointBalance);
  const runsOver = Math.max(0, -balances.runBalance);
  return {
    capUsd,
    rates,
    pointsOver,
    runsOver,
    committedUsd: rates
      ? projectedOverageUsd(balances.pointBalance, balances.runBalance, rates)
      : 0,
  };
}

/** Warning threshold: Contributors hear about it at 80% of the cap. */
export const OVERAGE_WARNING_RATIO = 0.8;

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
    const [points, runs] = await Promise.all([
      supabaseAdmin.rpc("point_balance", {
        p_org_id: orgId,
        p_period_start: opts.periodStart,
      }),
      supabaseAdmin.rpc("optimization_run_balance", {
        p_org_id: orgId,
        p_period_start: opts.periodStart,
      }),
    ]);
    const committedUsd = projectedOverageUsd(
      Number(points.data ?? 0),
      Number(runs.data ?? 0),
      rates
    );
    if (committedUsd < OVERAGE_WARNING_RATIO * opts.capUsd) return;

    await notifyLimitOnce({
      orgId,
      kind: "overage_warning",
      periodStart: opts.periodStart,
      subject: (teamName) => `${teamName} is approaching its overage cap`,
      html: (teamName, billingUrl) =>
        overageWarningEmailHtml({
          teamName,
          committedUsd,
          capUsd: opts.capUsd,
          billingUrl,
        }),
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

/** Settled overage lines for the period — the in-app invoice preview. */
export async function listOverageLines(
  orgId: string,
  periodStart: string
): Promise<Array<{ meter: OverageMeter; quantity: number }>> {
  const { data } = await supabaseAdmin
    .from("overage_invoice_lines")
    .select("meter, quantity")
    .eq("org_id", orgId)
    .eq("period_start", periodStart)
    .gt("quantity", 0);
  return (data ?? []) as Array<{ meter: OverageMeter; quantity: number }>;
}