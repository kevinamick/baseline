import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
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

  const { error: grantError } = await supabaseAdmin.rpc("ensure_optimization_grant", {
    p_org_id: orgId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_included: included,
  });
  if (grantError) {
    throw new Error(`ensure_optimization_grant failed: ${grantError.message}`);
  }

  const { data, error } = await supabaseAdmin.rpc("optimization_run_balance", {
    p_org_id: orgId,
    p_period_start: start.toISOString(),
  });
  if (error) throw new Error(`optimization_run_balance failed: ${error.message}`);

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
 * Atomically reserve one allowance unit for a run. Callers that already
 * resolved the period (the start action's pre-check) pass it through, saving
 * a second resolution round-trip and keeping the refusal message and the
 * reservation on the same period snapshot.
 *
 * Overage (#183): the app passes only the plan's unit rates; the SQL reads
 * the Team's cap itself and may take the balance negative while the projected
 * dollar overage across BOTH meters fits it, under the ordered advisory locks.
 */
export async function reserveOptimizationRun(
  orgId: string,
  runId: string,
  period?: { periodStart: string; periodEnd: string; included: number; plan: PlanSlug }
): Promise<{
  reserved: boolean;
  remaining: number;
  periodStart: string;
  capUsd: number | null;
  plan: PlanSlug;
  paymentFailing: boolean;
}> {
  // The payment-failing signal is independent of period resolution, so fetch it
  // concurrently with the (conditional) period read to save a round trip.
  const [resolved, paymentFailing] = await Promise.all([
    period ? null : resolvePointPeriod(orgId),
    paymentMethodFailing(orgId),
  ]);
  let p = period;
  if (!p) {
    const { plan, start, end } = resolved!;
    p = {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      included: PLANS[plan].includedOptimizationRuns,
      plan,
    };
  }
  // Suppress overage rates while the card is failing (#215) → the reserve
  // hard-stops at the included allotment instead of opening unpaid overage.
  const rates = paymentFailing ? null : overageRatesForPlan(p.plan);

  const { data, error } = await supabaseAdmin.rpc("reserve_optimization_run", {
    p_org_id: orgId,
    p_run_id: runId,
    p_period_start: p.periodStart,
    p_period_end: p.periodEnd,
    p_included: p.included,
    p_point_unit_usd: rates?.pointUnitUsd ?? null,
    p_run_unit_usd: rates?.runUnitUsd ?? null,
  });
  if (error) throw new Error(`reserve_optimization_run failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    reserved: Boolean(row?.reserved),
    remaining: Number(row?.balance ?? 0),
    periodStart: p.periodStart,
    capUsd: row?.cap_usd == null ? null : Number(row.cap_usd),
    plan: p.plan,
    paymentFailing,
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
