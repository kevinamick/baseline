import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { firstRow } from "@/lib/supabase/first-row";
import { rpcOrThrow, readRpcOrThrow } from "@/lib/supabase/rpc";
import { LEDGER_DISPLAY_LIMIT } from "@/lib/billing/ledger-display";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";
import { notifyBillingLimit, NOTIFICATION_KIND } from "@/lib/billing/limit-notifications";

/**
 * Server seam over the managed-spend ledger (#185, ADR-0008 Meter 2). All
 * mutation goes through the security-definer Postgres functions: reserve is
 * atomic under the per-org managed lock (keyspace 2), accrue/release are
 * append-only. The period's accrued total is always derived from the ledger.
 *
 * The Managed Spend Cap is the OVERRIDE in billing_settings when set, else the
 * plan default (code constant). A paid plan always has a default, so managed
 * spend is never unbounded; Free has no default (managed N/A — BYO only).
 */

export interface EffectiveManagedCap {
  /** Effective monthly cap in dollars, or null when managed spend is N/A (Free). */
  capUsd: number | null;
  /** True when capUsd came from the plan default (no Team override set). */
  isDefault: boolean;
  plan: PlanSlug;
}

/**
 * The Team's effective Managed Spend Cap: override ?? plan default.
 *
 * Returns the stored override verbatim — the trust ceiling (#188) is a *write-time*
 * guard enforced in setManagedSpendCap, not a clamp here. So a cap set while trust
 * was high stays in force if trust later drops (e.g. after a chargeback): the
 * ceiling only gates new raises, it doesn't retroactively lower an existing cap.
 */
export async function getEffectiveManagedCap(
  orgId: string,
): Promise<EffectiveManagedCap> {
  const [{ plan }, { data, error: capError }] = await Promise.all([
    getBillingState(orgId),
    supabaseAdmin
      .from("billing_settings")
      .select("managed_spend_cap_usd")
      .eq("org_id", orgId)
      .maybeSingle(),
  ]);
  if (capError) throw capError;

  const planDefault = PLANS[plan].defaultManagedSpendCapUsd;
  const override = data?.managed_spend_cap_usd;

  if (override != null) {
    return { capUsd: Number(override), isDefault: false, plan };
  }
  return {
    capUsd: planDefault == null ? null : Number(planDefault),
    isDefault: true,
    plan,
  };
}

/** The period's accrued managed spend in dollars (actuals only). */
export async function getManagedSpendTotal(
  orgId: string,
  periodStart: string,
): Promise<number> {
  const data = await readRpcOrThrow("managed_spend_total", {
    p_org_id: orgId,
    p_period_start: periodStart,
  });
  return Number(data ?? 0);
}

/**
 * The period's outstanding managed-spend reservations (#470) — dollars held
 * against the cap by runs still in flight, but not yet accrued or released.
 * `reserve_managed_spend` (the cap decision) and `release_managed_reservation`
 * (settlement) already maintain reserve/release rows that make this sum
 * meaningful; this is a read-only view over the same ledger `managed_spend_total`
 * reads, filtered to the OTHER entry types. Zero once every in-flight run has
 * settled (a run's reservation is released in full on any terminal outcome), so
 * a Team with nothing running always sees zero here even with accrued spend
 * this period.
 */
export async function getManagedSpendReservedTotal(
  orgId: string,
  periodStart: string,
): Promise<number> {
  const data = await readRpcOrThrow("managed_spend_reserved_total", {
    p_org_id: orgId,
    p_period_start: periodStart,
  });
  return Number(data ?? 0);
}

/**
 * The period's un-invoiced accrued managed spend (#186) — the credit currently
 * extended for the period, which threshold billing bounds. Derived from the
 * invoice mirror (Σ accrued − invoiced), maintained on every accrue.
 */
export async function getManagedUninvoicedTotal(
  orgId: string,
  periodStart: string,
): Promise<number> {
  const data = await readRpcOrThrow("managed_uninvoiced_total", {
    p_org_id: orgId,
    p_period_start: periodStart,
  });
  return Number(data ?? 0);
}

/**
 * Whether a Team's managed runs are fail-closed on a declined managed-token
 * invoice (#186). BYO runs are unaffected — this is checked only on the managed
 * path (see resolveKeyModeForEstimate / the worker meter). Reads the webhook-owned
 * mirror; null timestamp = healthy. Fails closed: an unreadable mirror blocks
 * managed runs rather than waving them through.
 */
export async function isManagedPaymentBlocked(orgId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("managed_payment_failed_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return true;
  return data?.managed_payment_failed_at != null;
}

/**
 * Whether the Team's payment method is failing — the signal that suspends NEW
 * unpaid credit (overage) across both meters and both key modes (#215). Overage
 * is billed in arrears, so a Team on a bad card could otherwise keep running up
 * unpaid platform-infra credit; this gates that while leaving prepaid/included
 * usage working (the principle: billing blocks the extension of *unpaid* credit,
 * never prepaid activity).
 *
 * "Failing" = the managed-token mirror is tripped (`managed_payment_failed_at`
 * set, #186) OR the subscription is `past_due`/`unpaid`. The status arm is mostly
 * belt-and-suspenders — a non-active subscription already floors the Team to Free
 * (no overage rates) via getBillingState — so the case this actually changes is
 * `managed_payment_failed_at` set while a Builder/Scale subscription is still
 * active, where included allotment otherwise continues with overage open.
 *
 * Fails closed (suppress overage on an unreadable signal): `isManagedPaymentBlocked`
 * already returns true on a read error, the safe direction for unpaid exposure.
 */
export async function paymentMethodFailing(orgId: string): Promise<boolean> {
  const [managedBlocked, { status }] = await Promise.all([
    isManagedPaymentBlocked(orgId),
    getBillingState(orgId),
  ]);
  return managedBlocked || status === "past_due" || status === "unpaid";
}

export interface ManagedSpendEntry {
  id: string;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  callKind: string | null;
  createdAt: string;
}

/**
 * The period's accrual rows, newest first — the Team-visible usage view. Bounded
 * to the most recent rows: managed_spend_ledger takes one accrue row per metered
 * LLM call (the hottest write path), so an active Team's period can hold thousands
 * of rows that the billing page would otherwise read and render in full. The
 * period total comes from getManagedSpendTotal, not from summing this list, so the
 * cap never skews the displayed spend.
 */
export async function getManagedSpendEntries(
  orgId: string,
  periodStart: string,
): Promise<ManagedSpendEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("managed_spend_ledger")
    .select(
      "id, provider, model, input_tokens, output_tokens, amount_usd, call_kind, created_at",
    )
    .eq("org_id", orgId)
    .eq("period_start", periodStart)
    .eq("entry_type", "accrue")
    .order("created_at", { ascending: false })
    .limit(LEDGER_DISPLAY_LIMIT);
  if (error) throw error;

  return (data ?? []).map((e) => ({
    id: e.id,
    provider: e.provider,
    model: e.model,
    inputTokens: e.input_tokens == null ? null : Number(e.input_tokens),
    outputTokens: e.output_tokens == null ? null : Number(e.output_tokens),
    costUsd: Number(e.amount_usd),
    callKind: e.call_kind,
    createdAt: e.created_at,
  }));
}

/**
 * Atomically reserve a run's pre-run dollar estimate against the cap. The SQL
 * serializes on the per-org managed lock, so concurrent runs can't jointly
 * overshoot. Returns whether the reservation was taken and the committed total
 * either way. Exactly one of evalRunId / optRunId must be set.
 */
export async function reserveManagedSpend(
  orgId: string,
  run: { evalRunId?: string; optRunId?: string },
  estimateUsd: number,
  capUsd: number,
  markupPct: number,
  period: { start: string; end: string },
): Promise<{ reserved: boolean; committedUsd: number }> {
  const data = await rpcOrThrow("reserve_managed_spend", {
    p_org_id: orgId,
    p_estimate_usd: estimateUsd,
    p_period_start: period.start,
    p_period_end: period.end,
    p_cap_usd: capUsd,
    p_markup_pct: markupPct,
    p_eval_run_id: run.evalRunId ?? null,
    p_opt_run_id: run.optRunId ?? null,
  });

  const row = firstRow(data);
  return {
    reserved: Boolean(row?.reserved),
    committedUsd: Number(row?.committed_usd ?? 0),
  };
}

/**
 * The managed-cap-reached email, throttled once per period. Owned here so the
 * eval and optimization run-start actions can't drift.
 */
export async function notifyManagedCapReached(
  orgId: string,
  capUsd: number,
  periodStart: string,
): Promise<void> {
  await notifyBillingLimit(NOTIFICATION_KIND.managedSpendLimit, orgId, periodStart, { capUsd });
}

/**
 * The managed-payment-failed email (#186), throttled once per period. Sent when a
 * threshold-billing invoice is declined and managed runs go fail-closed.
 */
export async function notifyManagedPaymentFailed(
  orgId: string,
  amountUsd: number,
  periodStart: string,
): Promise<void> {
  await notifyBillingLimit(NOTIFICATION_KIND.managedPaymentFailed, orgId, periodStart, {
    amountUsd,
  });
}
