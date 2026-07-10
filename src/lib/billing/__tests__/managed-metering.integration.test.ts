import { describe, it, expect, beforeAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

/**
 * Integration tests for Managed Key gateway metering & Managed Spend Cap (#185).
 * The reserve/accrue/release machinery and the append-only guarantee live in
 * Postgres, so they're verified against the real local database. Skipped when no
 * local Supabase env is available; run locally with .env.local exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run managed-metering.integration
 *
 * The period is derived from the run's existing point-ledger reserve, so each
 * test run first reserves points for its eval run (mirrors the real flow).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";
const CAP_USD = 10;
const MARKUP_PCT = 40;

describe.skipIf(!hasDb)("managed metering (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;

  // An eval run with a point reservation (so accrue can derive the period).
  async function newMeteredRun(): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const runId = data.id as string;
    const { error: rErr } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: 1,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: 1_000_000,
      p_meta: {},
    });
    if (rErr) throw new Error(rErr.message);
    return runId;
  }

  async function reserveManaged(runId: string, estimate: number) {
    const { data, error } = await db.rpc("reserve_managed_spend", {
      p_org_id: orgId,
      p_estimate_usd: estimate,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_cap_usd: CAP_USD,
      p_markup_pct: MARKUP_PCT,
      p_eval_run_id: runId,
      p_opt_run_id: null,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as {
      reserved: boolean;
      committed_usd: string;
    };
  }

  async function accrue(runId: string, amount: number): Promise<number> {
    const { data, error } = await db.rpc("accrue_managed_spend", {
      p_org_id: orgId,
      p_amount_usd: amount,
      p_provider: "anthropic",
      p_model: "claude-haiku-4-5-20251001",
      p_input_tokens: 1000,
      p_output_tokens: 200,
      p_input_unit_usd: 0.000001,
      p_output_unit_usd: 0.000005,
      p_markup_pct: MARKUP_PCT,
      p_call_kind: "judge",
      p_eval_run_id: runId,
      p_opt_run_id: null,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  async function total(): Promise<number> {
    const { data, error } = await db.rpc("managed_spend_total", {
      p_org_id: orgId,
      p_period_start: PERIOD_START,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Managed Metering Integration Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `managed-integration-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });

    const { data: rubric, error: rubricError } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Managed metering rubric",
        scenario_description: "integration",
        expected_outcome: "integration",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    if (rubricError) throw new Error(rubricError.message);
    rubricId = rubric.id;
  });

  it("reserves within the cap and refuses past it", async () => {
    const run1 = await newMeteredRun();
    const r1 = await reserveManaged(run1, 6);
    expect(r1.reserved).toBe(true);
    expect(Number(r1.committed_usd)).toBeCloseTo(6, 6);

    // 6 + 6 = 12 > 10 cap → refused; committed unchanged at 6.
    const run2 = await newMeteredRun();
    const r2 = await reserveManaged(run2, 6);
    expect(r2.reserved).toBe(false);
    expect(Number(r2.committed_usd)).toBeCloseTo(6, 6);
  });

  it("accrues append-only rows, derives the period, and returns the running total", async () => {
    const run = await newMeteredRun();
    const before = await total();
    const t1 = await accrue(run, 1.5);
    expect(t1).toBeCloseTo(before + 1.5, 6);
    const t2 = await accrue(run, 0.5);
    expect(t2).toBeCloseTo(before + 2.0, 6);

    // The accrual row carries the snapshotted prices + tokens (audit trail).
    const { data: rows } = await db
      .from("managed_spend_ledger")
      .select("provider, model, input_tokens, output_tokens, input_unit_usd, markup_pct")
      .eq("eval_run_id", run)
      .eq("entry_type", "accrue");
    expect(rows?.length).toBe(2);
    expect(rows?.[0].provider).toBe("anthropic");
    expect(Number(rows?.[0].markup_pct)).toBe(MARKUP_PCT);
  });

  it("is append-only: update and delete are denied even to the service role", async () => {
    const run = await newMeteredRun();
    await accrue(run, 1);
    const { error: updErr } = await db
      .from("managed_spend_ledger")
      .update({ amount_usd: 0 })
      .eq("eval_run_id", run);
    expect(updErr).not.toBeNull();
    const { error: delErr } = await db
      .from("managed_spend_ledger")
      .delete()
      .eq("eval_run_id", run);
    expect(delErr).not.toBeNull();
  });

  it("release converts committed back toward accrued actuals", async () => {
    const run = await newMeteredRun();
    await reserveManaged(run, 4); // reserve estimate $4
    await accrue(run, 1); // actual $1 so far
    // Release the reservation: committed for this run should reflect actuals only.
    const { error } = await db.rpc("release_managed_reservation", {
      p_eval_run_id: run,
      p_opt_run_id: null,
    });
    expect(error).toBeNull();

    const { data: ledger } = await db
      .from("managed_spend_ledger")
      .select("entry_type, amount_usd")
      .eq("eval_run_id", run);
    const net = (ledger ?? []).reduce((s, e) => {
      const a = Number(e.amount_usd);
      return e.entry_type === "release" ? s - a : s + a;
    }, 0);
    // reserve 4 + accrue 1 − release 4 = 1 (the actual).
    expect(net).toBeCloseTo(1, 6);
  });

  // #470: the billing page shows accrued spend (managed_spend_total) and
  // reserved-in-flight (managed_spend_reserved_total) as separate figures —
  // this proves the two RPCs the page reads reconcile with the ledger the
  // cap decision (reserve_managed_spend's v_committed = reserve + accrue -
  // release) already uses, and that reserved returns to zero once every
  // in-flight run has settled.
  it("reserved total reflects outstanding reservations and reconciles with accrued spend (#470)", async () => {
    // Fresh org so prior tests' committed spend against the shared $10 cap
    // doesn't interfere with the arithmetic asserted here.
    const { data: org } = await db
      .from("organizations")
      .insert({ name: "Managed reserved-total integration org" })
      .select("id")
      .single();
    const testOrg = org!.id as string;

    const reservedTotal = async (): Promise<number> => {
      const { data, error } = await db.rpc("managed_spend_reserved_total", {
        p_org_id: testOrg,
        p_period_start: PERIOD_START,
      });
      if (error) throw new Error(error.message);
      return Number(data);
    };
    const accruedTotal = async (): Promise<number> => {
      const { data, error } = await db.rpc("managed_spend_total", {
        p_org_id: testOrg,
        p_period_start: PERIOD_START,
      });
      if (error) throw new Error(error.message);
      return Number(data);
    };

    // Nothing running yet: the billing page's reserved line collapses to zero.
    expect(await reservedTotal()).toBe(0);
    expect(await accruedTotal()).toBe(0);

    // A run starts and reserves its upfront estimate — this is opt-4afa3642's
    // shape: a $13.52-equivalent hold while actual accrued spend is still low.
    const run1 = await newMeteredRun();
    await db.rpc("reserve_managed_spend", {
      p_org_id: testOrg,
      p_estimate_usd: 13.52,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_cap_usd: CAP_USD * 10, // headroom — this test is about the split, not the cap
      p_markup_pct: MARKUP_PCT,
      p_eval_run_id: run1,
      p_opt_run_id: null,
    });
    await db.rpc("accrue_managed_spend", {
      p_org_id: testOrg,
      p_amount_usd: 1.5,
      p_provider: "anthropic",
      p_model: "claude-haiku-4-5-20251001",
      p_input_tokens: 1000,
      p_output_tokens: 200,
      p_input_unit_usd: 0.000001,
      p_output_unit_usd: 0.000005,
      p_markup_pct: MARKUP_PCT,
      p_call_kind: "judge",
      p_eval_run_id: run1,
      p_opt_run_id: null,
    });

    // Mid-run: the reservation (13.52) is untouched by the accrue — the two
    // figures are independent, which is exactly the split #470 surfaces.
    expect(await reservedTotal()).toBeCloseTo(13.52, 6);
    expect(await accruedTotal()).toBeCloseTo(1.5, 6);

    // A second run reserves concurrently — reserved is org-wide, not per-run.
    const run2 = await newMeteredRun();
    await db.rpc("reserve_managed_spend", {
      p_org_id: testOrg,
      p_estimate_usd: 4,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_cap_usd: CAP_USD * 10,
      p_markup_pct: MARKUP_PCT,
      p_eval_run_id: run2,
      p_opt_run_id: null,
    });
    expect(await reservedTotal()).toBeCloseTo(17.52, 6);

    // run1 finishes: its outstanding reservation (13.52) releases in full,
    // regardless of how much of it was actually accrued (1.5).
    await db.rpc("release_managed_reservation", { p_eval_run_id: run1, p_opt_run_id: null });
    expect(await reservedTotal()).toBeCloseTo(4, 6); // only run2's hold remains
    expect(await accruedTotal()).toBeCloseTo(1.5, 6); // accrued spend is untouched by release

    // run2 finishes too: reserved collapses back to zero — nothing in flight.
    await db.rpc("release_managed_reservation", { p_eval_run_id: run2, p_opt_run_id: null });
    expect(await reservedTotal()).toBe(0);
    expect(await accruedTotal()).toBeCloseTo(1.5, 6);

    await db.from("organizations").delete().eq("id", testOrg);
  });

  it("concurrent reservations cannot jointly overshoot the cap (race)", async () => {
    // Fresh org so prior committed spend doesn't interfere.
    const { data: org } = await db
      .from("organizations")
      .insert({ name: "Managed race org" })
      .select("id")
      .single();
    const raceOrg = org!.id as string;
    const mkRun = async () => {
      const { data } = await db
        .from("eval_runs")
        .insert({ created_by: userId, rubric_id: rubricId })
        .select("id")
        .single();
      const runId = data!.id as string;
      await db.rpc("reserve_eval_points", {
        p_org_id: raceOrg,
        p_run_id: runId,
        p_cost: 1,
        p_period_start: PERIOD_START,
        p_period_end: PERIOD_END,
        p_included: 1_000_000,
        p_meta: {},
      });
      return runId;
    };
    const [runA, runB] = await Promise.all([mkRun(), mkRun()]);
    const reserve = (runId: string) =>
      db.rpc("reserve_managed_spend", {
        p_org_id: raceOrg,
        p_estimate_usd: 7, // each fits alone (7 ≤ 10) but 14 > 10 together
        p_period_start: PERIOD_START,
        p_period_end: PERIOD_END,
        p_cap_usd: CAP_USD,
        p_markup_pct: MARKUP_PCT,
        p_eval_run_id: runId,
        p_opt_run_id: null,
      });
    const [resA, resB] = await Promise.all([reserve(runA), reserve(runB)]);
    const rowA = (Array.isArray(resA.data) ? resA.data[0] : resA.data) as { reserved: boolean };
    const rowB = (Array.isArray(resB.data) ? resB.data[0] : resB.data) as { reserved: boolean };
    // Exactly one wins — the advisory lock serializes them.
    expect([rowA.reserved, rowB.reserved].filter(Boolean).length).toBe(1);

    await db.from("organizations").delete().eq("id", raceOrg);
  });

  it("denies anon/authenticated direct access (table grant revoked + RLS)", async () => {
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!anonKey) return; // anon key not exported — skip this assertion
    const anon = createClient(url!, anonKey, { auth: { persistSession: false } });
    const { data, error } = await anon
      .from("managed_spend_ledger")
      .select("id")
      .eq("org_id", orgId);
    // Grants are revoked from anon/authenticated (RLS deny-all is the backstop),
    // so a direct read is refused outright — never another org's spend leaks.
    expect(data ?? []).toHaveLength(0);
    expect(error?.code).toBe("42501"); // permission denied for table
  });
});
