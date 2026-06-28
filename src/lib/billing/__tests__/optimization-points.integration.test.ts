import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for the optimization-run point meter (ADR-0016): an overage
 * optimization run reserves worst-case Eval Points on the point_ledger and settles
 * to the rollouts actually scored. The atomicity / idempotency / scored-count math
 * lives in Postgres, so it's verified against the real local database. Same env
 * contract as ledger.integration.test.ts:
 *
 *   set -a; source .env.local; set +a; npx vitest run optimization-points.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";
const INCLUDED_POINTS = 1_000;
const PER_ROLLOUT = 25; // a 3-criterion rubric: 10 + 5×3

describe.skipIf(!hasDb)("optimization point meter (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;
  let connectionId: string;

  async function createOptRun(status = "failed"): Promise<string> {
    const { data, error } = await db
      .from("optimization_runs")
      .insert({
        org_id: orgId,
        created_by: userId,
        connection_id: connectionId,
        rubric_id: rubricId,
        eval_type: "tabular",
        budget_rollouts: 10,
        max_iters: 5,
        status,
        error_message: "integration fixture",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  // Persist `n` scored rollouts under one candidate, one judged criterion each —
  // so count(distinct rollout_id) in rollout_results = n.
  async function scoreRollouts(runId: string, n: number): Promise<void> {
    const { data: candidate, error: candErr } = await db
      .from("optimization_candidates")
      .insert({ opt_run_id: runId, generation: 0, prompts: { system: "seed" } })
      .select("id")
      .single();
    if (candErr) throw new Error(candErr.message);
    for (let i = 0; i < n; i++) {
      const { data: rollout, error: rErr } = await db
        .from("optimization_rollouts")
        .insert({ candidate_id: candidate!.id, phase: "minibatch", instance_index: i })
        .select("id")
        .single();
      if (rErr) throw new Error(rErr.message);
      const { error: resErr } = await db
        .from("rollout_results")
        .insert({ rollout_id: rollout!.id, criterion_name: "c1", score: 0.5, reasoning: "x" });
      if (resErr) throw new Error(resErr.message);
    }
  }

  async function reservePoints(
    runId: string,
    cost: number,
    pointUnitUsd: number | null = null
  ) {
    const { data, error } = await db.rpc("reserve_optimization_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: cost,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: INCLUDED_POINTS,
      p_meta: { per_rollout_cost: PER_ROLLOUT },
      p_point_unit_usd: pointUnitUsd,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as {
      reserved: boolean;
      balance: number;
      cap_usd: number | null;
    };
  }

  async function settlePoints(runId: string, outcome: string) {
    const { error } = await db.rpc("settle_optimization_run_points", {
      p_run_id: runId,
      p_outcome: outcome,
    });
    if (error) throw new Error(error.message);
  }

  async function pointBalance(): Promise<number> {
    const { data, error } = await db.rpc("point_balance", {
      p_org_id: orgId,
      p_period_start: PERIOD_START,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  async function entries(runId: string) {
    const { data } = await db
      .from("point_ledger")
      .select("entry_type, points")
      .eq("opt_run_id", runId);
    return data ?? [];
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Optimization Points Integration Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `opt-points-${crypto.randomUUID()}@example.com`,
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
        name: "Opt points test rubric",
        scenario_description: "integration",
        expected_outcome: "integration",
        evaluation_mode: "prompt_response",
        criteria: [
          { name: "c1", weight: 1, steps: ["s"] },
          { name: "c2", weight: 1, steps: ["s"] },
          { name: "c3", weight: 1, steps: ["s"] },
        ],
      })
      .select("id")
      .single();
    if (rubricError) throw new Error(rubricError.message);
    rubricId = rubric.id;

    const { data: conn, error: connError } = await db
      .from("connections")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Opt points test agent",
        kind: "agent",
        endpoint: "https://agent.example.com/run",
        request_template: { input: "{{user_input}}", system: "{{prompt:system}}" },
        response_path: "output",
        optimizable_prompts: [{ name: "system", seed: "be helpful" }],
      })
      .select("id")
      .single();
    if (connError) throw new Error(connError.message);
    connectionId = conn.id;
  });

  afterAll(async () => {
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  it("reserves worst-case points and settles a completed run to the scored count", async () => {
    const runId = await createOptRun("completed");
    // Worst case = budget_rollouts(10) × per-rollout(25) = 250.
    const res = await reservePoints(runId, 10 * PER_ROLLOUT);
    expect(res.reserved).toBe(true);
    expect(res.balance).toBe(INCLUDED_POINTS - 250);

    // Only 4 rollouts actually scored — completed still settles to actual, not the ceiling.
    await scoreRollouts(runId, 4);
    await settlePoints(runId, "completed");

    const runEntries = await entries(runId);
    expect(runEntries.find((e) => e.entry_type === "settle")?.points).toBe(4 * PER_ROLLOUT); // 100
    expect(runEntries.find((e) => e.entry_type === "release")?.points).toBe(250 - 4 * PER_ROLLOUT); // 150
    // Net consumed = 100; balance = 1000 − 250 reserve + 150 release.
    expect(await pointBalance()).toBe(INCLUDED_POINTS - 4 * PER_ROLLOUT);
  });

  it("a failed run with no scored rollouts releases the whole reservation; replay is a no-op", async () => {
    const before = await pointBalance();
    const runId = await createOptRun("failed");
    await reservePoints(runId, 10 * PER_ROLLOUT);
    expect(await pointBalance()).toBe(before - 250);

    for (let i = 0; i < 2; i++) await settlePoints(runId, "failed");

    const runEntries = await entries(runId);
    expect(runEntries.find((e) => e.entry_type === "settle")?.points).toBe(0);
    expect(runEntries.filter((e) => e.entry_type === "release")).toHaveLength(1);
    expect(runEntries.find((e) => e.entry_type === "release")?.points).toBe(250);
    expect(await pointBalance()).toBe(before); // fully returned
  });

  it("skipped settles zero and releases all", async () => {
    const before = await pointBalance();
    const runId = await createOptRun("failed");
    await reservePoints(runId, 10 * PER_ROLLOUT);
    await settlePoints(runId, "skipped");
    expect(await pointBalance()).toBe(before);
  });

  it("refuses a reserve past the balance when no overage cap is set", async () => {
    const runId = await createOptRun("failed");
    const res = await reservePoints(runId, INCLUDED_POINTS * 100);
    expect(res.reserved).toBe(false);
  });
});
