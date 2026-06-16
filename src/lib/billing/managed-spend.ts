import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { managedSpendLimitEmailHtml } from "@/lib/email/templates/managed-spend";

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

/** The Team's effective Managed Spend Cap: override ?? plan default. */
export async function getEffectiveManagedCap(
  orgId: string,
): Promise<EffectiveManagedCap> {
  const [{ plan }, { data }] = await Promise.all([
    getBillingState(orgId),
    supabaseAdmin
      .from("billing_settings")
      .select("managed_spend_cap_usd")
      .eq("org_id", orgId)
      .maybeSingle(),
  ]);

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
  const { data, error } = await supabaseAdmin.rpc("managed_spend_total", {
    p_org_id: orgId,
    p_period_start: periodStart,
  });
  if (error) throw new Error(`managed_spend_total failed: ${error.message}`);
  return Number(data ?? 0);
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

/** The period's accrual rows, newest first — the Team-visible usage view. */
export async function getManagedSpendEntries(
  orgId: string,
  periodStart: string,
): Promise<ManagedSpendEntry[]> {
  const { data } = await supabaseAdmin
    .from("managed_spend_ledger")
    .select(
      "id, provider, model, input_tokens, output_tokens, amount_usd, call_kind, created_at",
    )
    .eq("org_id", orgId)
    .eq("period_start", periodStart)
    .eq("entry_type", "accrue")
    .order("created_at", { ascending: false });

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
  const { data, error } = await supabaseAdmin.rpc("reserve_managed_spend", {
    p_org_id: orgId,
    p_estimate_usd: estimateUsd,
    p_period_start: period.start,
    p_period_end: period.end,
    p_cap_usd: capUsd,
    p_markup_pct: markupPct,
    p_eval_run_id: run.evalRunId ?? null,
    p_opt_run_id: run.optRunId ?? null,
  });
  if (error) throw new Error(`reserve_managed_spend failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
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
  await notifyLimitOnce({
    orgId,
    kind: "managed_spend_limit",
    periodStart,
    subject: (teamName) => `${teamName} has reached its managed spend cap`,
    html: (teamName, billingUrl) =>
      managedSpendLimitEmailHtml({ teamName, capUsd, billingUrl }),
  });
}
