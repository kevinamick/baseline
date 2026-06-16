import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBillingState } from "@/lib/billing/state";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { anniversaryPeriod } from "@/lib/billing/period";
import { overageRatesForPlan } from "@/lib/billing/overage";

/**
 * Server seam over the Point Ledger (#180, ADR-0009). All mutation goes
 * through the security-definer Postgres functions — reserve is atomic under a
 * per-org lock, settle is idempotent — and the balance is always derived from
 * the ledger, never stored.
 *
 * Scope notes (S3):
 * - Only createEvalRun reserves. Schedule-spawned runs (the pg_cron tick in
 *   tick_schedules) are NOT metered yet — their rows resolve in the worker, so
 *   their cost isn't knowable at creation. Anyone adding a run-creation path
 *   must reserve here or knowingly ship it unmetered; the deeper fix is
 *   reserving at worker claim time, where rows always exist (S4 orbit).
 * - A period's grant freezes at first touch (`on conflict do nothing`). Plan
 *   changes mid-period are S5's delta-grant entries (#182); bumping a plan's
 *   includedEvalPoints constant mid-period will NOT retro-grant open periods.
 */

export interface PointBudget {
  plan: PlanSlug;
  included: number;
  /** Signed sum of the period's ledger; reservations already count as spent. */
  balance: number;
  periodStart: string;
  periodEnd: string;
}

/** Mirrors the point_ledger entry_type check constraint. */
export const LEDGER_ENTRY_TYPES = [
  "grant",
  "reserve",
  "settle",
  "release",
  "upgrade",
] as const;

export interface LedgerEntry {
  id: string;
  entryType: (typeof LEDGER_ENTRY_TYPES)[number];
  points: number;
  evalRunId: string | null;
  createdAt: string;
}

/**
 * The org's current point period and included allotment. Paid Teams anchor to
 * the mirrored Stripe period; Free Teams (and any active subscription whose
 * mirror is missing period bounds — a data gap, not a reason to fail the
 * Team's runs) anchor to the Team-creation anniversary, day-clamped.
 */
export async function resolvePointPeriod(orgId: string): Promise<{
  plan: PlanSlug;
  included: number;
  start: Date;
  end: Date;
}> {
  // Fetched together: the org row is only needed on the Free branch, but the
  // extra read is cheaper than serialising two round-trips on the hot path.
  const [billing, { data: org }] = await Promise.all([
    getBillingState(orgId),
    supabaseAdmin
      .from("organizations")
      .select("created_at")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  const plan = billing.plan;
  const included = PLANS[plan].includedEvalPoints;

  if (billing.active && billing.currentPeriodStart && billing.currentPeriodEnd) {
    return {
      plan,
      included,
      start: new Date(billing.currentPeriodStart),
      end: new Date(billing.currentPeriodEnd),
    };
  }

  // A missing org row means the caller's orgId is bogus; the epoch anchor keeps
  // the math total but every period long predates any ledger entry.
  const anchor = new Date(org?.created_at ?? 0);
  const { start, end } = anniversaryPeriod(anchor, new Date());
  return { plan, included, start, end };
}

/** Current balance + period, materialising the period's grant if needed. */
export async function getPointBudget(orgId: string): Promise<PointBudget> {
  const { plan, included, start, end } = await resolvePointPeriod(orgId);

  const { error: grantError } = await supabaseAdmin.rpc("ensure_point_grant", {
    p_org_id: orgId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_included: included,
  });
  if (grantError) throw new Error(`ensure_point_grant failed: ${grantError.message}`);

  const { data, error } = await supabaseAdmin.rpc("point_balance", {
    p_org_id: orgId,
    p_period_start: start.toISOString(),
  });
  if (error) throw new Error(`point_balance failed: ${error.message}`);

  return {
    plan,
    included,
    balance: Number(data ?? 0),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

/**
 * Atomically reserve a run's exact cost against the current period.
 * Returns the post-call balance either way: on refusal that is the unchanged
 * balance the decision was made against, for the "needed X, have Y" message.
 *
 * Overage (#183): the app passes only the plan's unit rates (code constants);
 * the SQL reads the Team's cap itself — the decision always uses the cap at
 * reserve time — and may take the balance negative while the projected dollar
 * overage across both meters fits it. `capUsd` echoes what was enforced so
 * callers can shape the refusal message and emails.
 */
export async function reserveEvalRunPoints(
  orgId: string,
  runId: string,
  cost: number,
  meta: { row_count: number; criteria_count: number; per_row_cost: number }
): Promise<{
  reserved: boolean;
  balance: number;
  periodStart: string;
  periodEnd: string;
  capUsd: number | null;
  plan: PlanSlug;
}> {
  const { plan, included, start, end } = await resolvePointPeriod(orgId);
  const rates = overageRatesForPlan(plan);

  const { data, error } = await supabaseAdmin.rpc("reserve_eval_points", {
    p_org_id: orgId,
    p_run_id: runId,
    p_cost: cost,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_included: included,
    p_meta: meta,
    p_point_unit_usd: rates?.pointUnitUsd ?? null,
    p_run_unit_usd: rates?.runUnitUsd ?? null,
  });
  if (error) throw new Error(`reserve_eval_points failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    reserved: Boolean(row?.reserved),
    balance: Number(row?.balance ?? 0),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    capUsd: row?.cap_usd == null ? null : Number(row.cap_usd),
    plan,
  };
}

/** The current period's entries, newest first — the Team-visible audit trail. */
export async function listLedgerEntries(
  orgId: string,
  periodStart: string
): Promise<LedgerEntry[]> {
  const { data } = await supabaseAdmin
    .from("point_ledger")
    .select("id, entry_type, points, eval_run_id, created_at")
    .eq("org_id", orgId)
    .eq("period_start", periodStart)
    .order("created_at", { ascending: false });

  return (data ?? []).map((e) => ({
    id: e.id,
    entryType: e.entry_type as LedgerEntry["entryType"],
    points: Number(e.points),
    evalRunId: e.eval_run_id,
    createdAt: e.created_at,
  }));
}
