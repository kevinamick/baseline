import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { firstRow } from "@/lib/supabase/first-row";
import { rpcOrThrow } from "@/lib/supabase/rpc";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { resolvePointPeriod } from "@/lib/billing/ledger";
import { overageRatesForPlan } from "@/lib/billing/overage";
import { paymentMethodFailing } from "@/lib/billing/managed-spend";

/**
 * Server seam over the Optimization Run allowance ledger (#181, ADR-0008) —
 * the second consumable meter, unit-denominated, sharing the Eval Point
 * period anchors (one Team, one period, two pools). Same contracts as the
 * point ledger: atomic reserve under a per-org lock, derived idempotent
 * settle, balance always the sum of the ledger.
 */

export interface OptimizationAllowance {
  plan: PlanSlug;
  included: number;
  maxBudgetRollouts: number;
  /** Units left this period; reservations count as spent. */
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

export async function getOptimizationAllowance(
  orgId: string
): Promise<OptimizationAllowance> {
  const { plan, start, end } = await resolvePointPeriod(orgId);
  const included = PLANS[plan].includedOptimizationRuns;

  await rpcOrThrow("ensure_optimization_grant", {
    p_org_id: orgId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_included: included,
  });

  const data = await rpcOrThrow("optimization_run_balance", {
    p_org_id: orgId,
    p_period_start: start.toISOString(),
  });

  return {
    plan,
    included,
    maxBudgetRollouts: PLANS[plan].maxBudgetRollouts,
    remaining: Number(data ?? 0),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

/**
 * Atomically reserve one included allowance unit for a run. Callers that
 * already resolved the period (the start action's pre-check) pass it through,
 * saving a second resolution round-trip and keeping the refusal message and the
 * reservation on the same period snapshot.
 *
 * Plain hard-stop (ADR-0016): the included run-count is the whole benefit and
 * overage is metered in Eval Points (`reserveOptimizationPoints`), so this never
 * goes negative and carries no cap/rate plumbing. The start gate only calls it
 * within allowance; a refusal here means a concurrent run took the last unit.
 */
export async function reserveOptimizationRun(
  orgId: string,
  runId: string,
  period?: { periodStart: string; periodEnd: string; included: number; plan: PlanSlug }
): Promise<{
  reserved: boolean;
  remaining: number;
  periodStart: string;
  plan: PlanSlug;
}> {
  let p = period;
  if (!p) {
    const { plan, start, end } = await resolvePointPeriod(orgId);
    p = {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      included: PLANS[plan].includedOptimizationRuns,
      plan,
    };
  }

  const data = await rpcOrThrow("reserve_optimization_run", {
    p_org_id: orgId,
    p_run_id: runId,
    p_period_start: p.periodStart,
    p_period_end: p.periodEnd,
    p_included: p.included,
  });

  const row = firstRow(data);
  return {
    reserved: Boolean(row?.reserved),
    remaining: Number(row?.balance ?? 0),
    periodStart: p.periodStart,
    plan: p.plan,
  };
}

/**
 * Release/settle a run's allowance unit before its row is deleted (the delete
 * nulls the ledger FK — same one-way door as the point ledger). The outcome is
 * derived in SQL: no Rollouts executed → released. Failures are logged loudly
 * by callers; this returns the error rather than throwing so rollback paths
 * can proceed.
 */
export async function settleOptimizationRunUnit(
  runId: string
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabaseAdmin.rpc("settle_optimization_run", {
    p_run_id: runId,
  });
  return { error };
}

/**
 * Reserve worst-case Eval Points for an OVERAGE optimization run (ADR-0016) —
 * a paid Team past its included run-count. `cost` is the budget-ceiling cost
 * (`optimizationRunPointCost(budget_rollouts, criteria)`); `meta.per_rollout_cost`
 * freezes pricing for the settle. Same point-meter contract as
 * `reserveEvalRunPoints`: atomic under the points advisory lock, may dig into
 * cap-backed overage, suppressed to a hard-stop while the card is failing (#215).
 */
export async function reserveOptimizationPoints(
  orgId: string,
  runId: string,
  cost: number,
  meta: { criteria_count: number; budget_rollouts: number; per_rollout_cost: number }
): Promise<{
  reserved: boolean;
  balance: number;
  periodStart: string;
  periodEnd: string;
  capUsd: number | null;
  plan: PlanSlug;
  paymentFailing: boolean;
}> {
  const { plan, included, start, end } = await resolvePointPeriod(orgId);
  const paymentFailing = await paymentMethodFailing(orgId);
  const rates = paymentFailing ? null : overageRatesForPlan(plan);

  const data = await rpcOrThrow("reserve_optimization_points", {
    p_org_id: orgId,
    p_run_id: runId,
    p_cost: cost,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_included: included,
    p_meta: meta,
    p_point_unit_usd: rates?.pointUnitUsd ?? null,
  });

  const row = firstRow(data);
  return {
    reserved: Boolean(row?.reserved),
    balance: Number(row?.balance ?? 0),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    capUsd: row?.cap_usd == null ? null : Number(row.cap_usd),
    plan,
    paymentFailing,
  };
}

/**
 * Settle an overage run's POINT reservation at terminal state (ADR-0016).
 * Idempotent in SQL and a no-op for within-allowance runs (no point reserve).
 * Returns the error rather than throwing so rollback paths can proceed.
 */
export async function settleOptimizationRunPoints(
  runId: string,
  outcome: "completed" | "failed" | "skipped"
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabaseAdmin.rpc("settle_optimization_run_points", {
    p_run_id: runId,
    p_outcome: outcome,
  });
  return { error };
}
