import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for the Optimization Run allowance SQL (#181) against the
 * real local database. Same env contract as ledger.integration.test.ts:
 *
 *   set -a; source .env.local; set +a; npx vitest run allowance.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";

describe.skipIf(!hasDb)("optimization run allowance (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;
  let connectionId: string;

  async function createRun(): Promise<string> {
    // The one-active-run-per-org partial unique index forces terminal inserts.
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
        status: "failed",
        error_message: "integration fixture",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async function reserve(runId: string | null, included = 7) {
    const { data, error } = await db.rpc("reserve_optimization_run", {
      p_org_id: orgId,
      p_run_id: runId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: included,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as { reserved: boolean; balance: number };
  }

  async function balance(): Promise<number> {
    const { data, error } = await db.rpc("optimization_run_balance", {
      p_org_id: orgId,
      p_period_start: PERIOD_START,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  async function entries(runId: string) {
    const { data } = await db
      .from("optimization_run_ledger")
      .select("entry_type, units")
      .eq("opt_run_id", runId);
    return data ?? [];
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Allowance Integration Test Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `allowance-integration-${crypto.randomUUID()}@example.com`,
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
        name: "Allowance test rubric",
        scenario_description: "integration",
        expected_outcome: "integration",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
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
        name: "Allowance test agent",
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

  it("grants lazily and reserves one unit at a time", async () => {
    const runId = await createRun();
    const res = await reserve(runId);
    expect(res).toMatchObject({ reserved: true, balance: 6 });
    expect(await balance()).toBe(6);
  });

  it("concurrent reservations can never jointly exceed the allowance", async () => {
    // 6 remaining; ten racing one-unit reservations → exactly 6 win.
    const runIds = await Promise.all(Array.from({ length: 10 }, createRun));
    const results = await Promise.all(runIds.map((id) => reserve(id)));
    expect(results.filter((r) => r.reserved)).toHaveLength(6);
    expect(await balance()).toBe(0);
  });

  it("a run with no Rollouts releases its unit on settle; replay is a no-op", async () => {
    // Balance is 0 — settle one of the raced runs (no rollouts → released).
    const { data: reserveRow } = await db
      .from("optimization_run_ledger")
      .select("opt_run_id")
      .eq("org_id", orgId)
      .eq("entry_type", "reserve")
      .not("opt_run_id", "is", null)
      .limit(1)
      .single();
    const runId = reserveRow!.opt_run_id as string;

    for (let i = 0; i < 2; i++) {
      const { error } = await db.rpc("settle_optimization_run", { p_run_id: runId });
      expect(error).toBeNull();
    }
    const runEntries = await entries(runId);
    expect(runEntries.find((e) => e.entry_type === "settle")?.units).toBe(0);
    expect(runEntries.filter((e) => e.entry_type === "release")).toHaveLength(1);
    expect(await balance()).toBe(1);
  });

  it("a run that executed Rollouts settles as consumed", async () => {
    const runId = await createRun();
    const res = await reserve(runId);
    expect(res.reserved).toBe(true);

    // Real work: a candidate with one rollout.
    const { data: candidate, error: candError } = await db
      .from("optimization_candidates")
      .insert({ opt_run_id: runId, generation: 0, prompts: { system: "seed" } })
      .select("id")
      .single();
    expect(candError).toBeNull();
    const { error: rolloutError } = await db.from("optimization_rollouts").insert({
      candidate_id: candidate!.id,
      phase: "minibatch",
      instance_index: 0,
    });
    expect(rolloutError).toBeNull();

    await db.rpc("settle_optimization_run", { p_run_id: runId });
    const runEntries = await entries(runId);
    expect(runEntries.find((e) => e.entry_type === "settle")?.units).toBe(1);
    expect(runEntries.some((e) => e.entry_type === "release")).toBe(false);
    expect(await balance()).toBe(0); // unit stays consumed
  });

  it("the reaper sweep settles every terminal run whose settle call was lost", async () => {
    // The earlier tests left several failed fixture runs holding reservations
    // that were never settled — exactly the crash-stranded state the sweep
    // exists for. After one sweep, no reservation may remain open: the one
    // consumed unit stays spent, every no-work reservation is released.
    const { error } = await db.rpc("reap_stale_optimization_runs", {
      p_threshold_minutes: 30,
    });
    expect(error).toBeNull();

    const { data: ledger } = await db
      .from("optimization_run_ledger")
      .select("entry_type, opt_run_id")
      .eq("org_id", orgId);
    const reserves = ledger!.filter((e) => e.entry_type === "reserve");
    const settles = new Set(
      ledger!.filter((e) => e.entry_type === "settle").map((e) => e.opt_run_id)
    );
    for (const r of reserves) {
      expect(settles.has(r.opt_run_id)).toBe(true);
    }
    // included 7 − 1 consumed = 6 back in the pool.
    expect(await balance()).toBe(6);
  });

  it("optimization_lifetime_used counts net consumption across the whole ledger", async () => {
    // Free's lifetime grant derives from this sum (reserves minus releases,
    // grants/settles ignored). The tests above produced the ledger organically
    // via the real reserve/settle/reap RPCs and left exactly ONE consumed unit
    // (every other reservation was released), so the lifetime count is 1.
    const { data, error } = await db.rpc("optimization_lifetime_used", {
      p_org_id: orgId,
    });
    expect(error).toBeNull();
    expect(Number(data)).toBe(1);
  });

  it("optimization_lifetime_used is zero for an org with no ledger history", async () => {
    const { data, error } = await db.rpc("optimization_lifetime_used", {
      p_org_id: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    expect(Number(data)).toBe(0);
  });
});
