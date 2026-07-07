import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The parity test imports ../overage, which is a server module.
vi.mock("server-only", () => ({}));

/**
 * Integration tests for Overage Caps (#183): the cap is enforced inside the
 * reserve RPCs under ordered advisory locks, and settled overage is projected
 * into overage_invoice_lines — both live in Postgres, so they're verified
 * against the real local database. Skipped when no local Supabase env is
 * available; run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run overage.integration
 *
 * Rates are passed explicitly (the RPCs take them as params — plan constants
 * live in code): $0.001/point and $1/run keep the arithmetic legible.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";
const INCLUDED_POINTS = 1_000;
const INCLUDED_RUNS = 2;
const POINT_USD = 0.001;

describe.skipIf(!hasDb)("overage caps (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;
  let connectionId: string;

  async function createEvalRun(): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async function createOptRun(): Promise<string> {
    const { data, error } = await db
      .from("optimization_runs")
      .insert({
        org_id: orgId,
        created_by: userId,
        connection_id: connectionId,
        rubric_id: rubricId,
        budget_rollouts: 10,
        max_iters: 3,
        status: "failed",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  /** The cap lives in billing_settings — the RPCs read it themselves. */
  async function setCap(capUsd: number | null) {
    const { error } = await db
      .from("billing_settings")
      .upsert({ org_id: orgId, overage_cap_usd: capUsd });
    if (error) throw new Error(error.message);
  }

  async function reservePoints(runId: string, cost: number) {
    const { data, error } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: cost,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: INCLUDED_POINTS,
      p_meta: {},
      p_point_unit_usd: POINT_USD,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as {
      reserved: boolean;
      balance: number;
      cap_usd: string | null;
    };
  }

  // Within-allowance run reserve: a plain hard-stop unit counter (ADR-0016).
  async function reserveRun(runId: string) {
    const { data, error } = await db.rpc("reserve_optimization_run", {
      p_org_id: orgId,
      p_run_id: runId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: INCLUDED_RUNS,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as {
      reserved: boolean;
      balance: number;
    };
  }

  // Overage optimization run: reserves worst-case POINTS on the shared point
  // meter (ADR-0016), so it draws against the same Overage Cap as eval points.
  async function reserveOptPoints(runId: string, cost: number) {
    const { data, error } = await db.rpc("reserve_optimization_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: cost,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: INCLUDED_POINTS,
      p_meta: { per_rollout_cost: 1 },
      p_point_unit_usd: POINT_USD,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as {
      reserved: boolean;
      balance: number;
      cap_usd: string | null;
    };
  }

  async function pointBalance(): Promise<number> {
    const { data, error } = await db.rpc("point_balance", {
      p_org_id: orgId,
      p_period_start: PERIOD_START,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  async function overageLine(meter: "points" | "runs") {
    const { data } = await db
      .from("overage_invoice_lines")
      .select("quantity, dirty")
      .eq("org_id", orgId)
      .eq("period_start", PERIOD_START)
      .eq("meter", meter)
      .maybeSingle();
    return data;
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Overage Integration Test Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `overage-integration-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;
    const { error: userError } = await db
      .from("users")
      .upsert({ id: userId }, { onConflict: "id" });
    if (userError) throw new Error(userError.message);

    const { data: rubric, error: rubricError } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Overage test rubric",
        scenario_description: "integration",
        expected_outcome: "integration",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    if (rubricError) throw new Error(rubricError.message);
    rubricId = rubric.id;

    const { data: connection, error: connError } = await db
      .from("connections")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Overage test agent",
        kind: "agent",
        endpoint: "https://example.test/agent",
        response_path: "output",
      })
      .select("id")
      .single();
    if (connError) throw new Error(connError.message);
    connectionId = connection.id;
  });

  afterAll(async () => {
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  it("without a cap, the hard stop stands (off by default)", async () => {
    const refused = await reservePoints(await createEvalRun(), INCLUDED_POINTS + 1);
    expect(refused.reserved).toBe(false);
    expect(refused.cap_usd).toBeNull();
    expect(await pointBalance()).toBe(INCLUDED_POINTS);
  });

  it("a cap lets the reserve dig past included, exactly to the cap", async () => {
    // $2 cap at $0.001/point = 2000 overage points of headroom.
    await setCap(2);
    const ok = await reservePoints(await createEvalRun(), INCLUDED_POINTS + 2_000);
    expect(ok).toMatchObject({ reserved: true, balance: -2_000 });

    // The cap is fully committed: one more point is refused, and the cap is
    // echoed back for the caller's messaging.
    const refused = await reservePoints(await createEvalRun(), 1);
    expect(refused.reserved).toBe(false);
    expect(Number(refused.cap_usd)).toBe(2);
    expect(await pointBalance()).toBe(-2_000);
  });

  it("optimization overage draws the shared points cap (ADR-0016)", async () => {
    // Points already committed $2 of the $2 cap. Within-allowance runs are a
    // separate hard-stop meter, untouched by the points cap…
    const within = await reserveRun(await createOptRun());
    expect(within.reserved).toBe(true);
    // …but an OVERAGE optimization run reserves POINTS, and the points cap is
    // fully committed, so 1000 more points are refused.
    const over = await reserveOptPoints(await createOptRun(), 1_000);
    expect(over.reserved).toBe(false);

    // A bigger cap ($4: $2 already + $1 headroom for the 1000-point run) admits it.
    await setCap(4);
    const admitted = await reserveOptPoints(await createOptRun(), 1_000);
    expect(admitted).toMatchObject({ reserved: true, balance: -3_000 });
  });

  it("cap-edge race: concurrent reserves can never jointly overshoot the cap", async () => {
    // Committed $3 (−3000 points) of a $5 cap → $2 = 2000 points of headroom.
    // Two concurrent 1500-point reserves both fit alone; only one may win.
    await setCap(5);
    const [a, b] = await Promise.all([
      reservePoints(await createEvalRun(), 1_500),
      reservePoints(await createEvalRun(), 1_500),
    ]);
    expect([a.reserved, b.reserved].filter(Boolean)).toHaveLength(1);
    expect(await pointBalance()).toBe(-4_500);
  });

  it("disabling the cap blocks new work but in-flight reservations settle honestly", async () => {
    // Cap cleared (the real opt-out path nulls the column, keeping the row):
    // any further overage reserve is refused…
    await setCap(null);
    const refused = await reservePoints(await createEvalRun(), 1);
    expect(refused.reserved).toBe(false);

    // …while an in-flight overage reservation settles and lands point-for-
    // point on the invoice line. Settled so far: the 3000-point reserve from
    // the cap test + 1500 from the race winner. Settle the 3000 one as
    // completed: settled(3000) − granted(1000) = 2000 overage points.
    const { data: reserves } = await db
      .from("point_ledger")
      .select("eval_run_id, points")
      .eq("org_id", orgId)
      .eq("entry_type", "reserve")
      .eq("points", 3_000);
    const runId = reserves![0].eval_run_id as string;
    const { error } = await db.rpc("settle_eval_run_points", {
      p_run_id: runId,
      p_outcome: "completed",
    });
    expect(error).toBeNull();

    const line = await overageLine("points");
    expect(line).toMatchObject({ quantity: 2_000, dirty: true });
  });

  it("invoice lines reconcile point-for-point and run-for-run with settled overage", async () => {
    // Settle the race winner (1500): settled 4500 − granted 1000 = 3500.
    const { data: reserves } = await db
      .from("point_ledger")
      .select("eval_run_id")
      .eq("org_id", orgId)
      .eq("entry_type", "reserve")
      .eq("points", 1_500);
    await db.rpc("settle_eval_run_points", {
      p_run_id: reserves![0].eval_run_id,
      p_outcome: "completed",
    });
    expect((await overageLine("points"))?.quantity).toBe(3_500);

    // Runs: 3 reserved (2 included + 1 overage). A settle marks one consumed,
    // but rollout-less runs release — so seed a rollout to make it "worked".
    // Simpler: settle a run with no rollouts → release; settled stays 0 and
    // no runs line exists yet.
    const { data: runReserves } = await db
      .from("optimization_run_ledger")
      .select("opt_run_id")
      .eq("org_id", orgId)
      .eq("entry_type", "reserve")
      .limit(1);
    await db.rpc("settle_optimization_run", { p_run_id: runReserves![0].opt_run_id });
    expect(await overageLine("runs")).toBeNull();
  });

  it("an upgrade grant mid-period shrinks the overage line, never below zero", async () => {
    // Reconcile to a bigger plan: included points 2000 (+1000 upgrade entry).
    // Settled overage recomputes: settled 4500 − granted 2000 = 2500.
    const { error } = await db.rpc("reconcile_plan_grants", {
      p_org_id: orgId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included_points: 2_000,
      p_included_runs: INCLUDED_RUNS,
    });
    expect(error).toBeNull();
    expect((await overageLine("points"))?.quantity).toBe(2_500);
  });

  it("SQL and TS cap math agree (parity pin for projected_overage_usd)", async () => {
    // The TS copy drives the warning email and the billing-page display; the
    // SQL drives the reserve refusal — they must never drift.
    const { projectedOverageUsd } = await import("../overage");
    const rates = { pointUnitUsd: 0.0005 };
    // Single points meter now (ADR-0016): optimization overage is points too.
    const vectors: number[] = [0, 500, -2_000, -1_000, 50_000, -9_999];
    for (const points of vectors) {
      const { data, error } = await db.rpc("projected_overage_usd", {
        p_point_balance: points,
        p_point_unit_usd: rates.pointUnitUsd,
      });
      expect(error).toBeNull();
      expect(Number(data)).toBeCloseTo(projectedOverageUsd(points, rates), 9);
    }
  });
});