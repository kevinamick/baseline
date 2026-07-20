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

  it("optimization_lifetime_used ignores unflagged (paid) consumption (CR-3, #501)", async () => {
    // The tests above produced the ledger organically via the real
    // reserve/settle/reap RPCs, none of which passed p_lifetime, and left
    // exactly ONE consumed unit (every other reservation was released).
    // Before CR-3's fix this org-wide sum counted that consumption; now only
    // reserves explicitly stamped as lifetime consumption count, so a paid
    // Team that floors to Free never has its own past paid usage charged
    // against a lifetime grant it never received. See the dedicated
    // "lifetime flag scoping" describe block below for the positive case.
    const { data, error } = await db.rpc("optimization_lifetime_used", {
      p_org_id: orgId,
    });
    expect(error).toBeNull();
    expect(Number(data)).toBe(0);
  });

  it("optimization_lifetime_used is zero for an org with no ledger history", async () => {
    const { data, error } = await db.rpc("optimization_lifetime_used", {
      p_org_id: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    expect(Number(data)).toBe(0);
  });
});

describe.skipIf(!hasDb)("optimization_lifetime_used lifetime flag scoping (CR-3, #501)", () => {
  let db: SupabaseClient;
  let scopedOrgId: string;

  const FREE_PERIOD_START = "2026-01-01T00:00:00.000Z";
  const FREE_PERIOD_END = "2026-02-01T00:00:00.000Z";
  const PAID_PERIOD_START = "2026-02-01T00:00:00.000Z";
  const PAID_PERIOD_END = "2026-03-01T00:00:00.000Z";

  const used = async () => {
    const { data, error } = await db.rpc("optimization_lifetime_used", {
      p_org_id: scopedOrgId,
    });
    expect(error).toBeNull();
    return Number(data);
  };

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const { data, error } = await db
      .from("organizations")
      .insert({ name: "Lifetime scope CR-3 test org" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    scopedOrgId = data.id;
  });

  afterAll(async () => {
    if (scopedOrgId) await db.from("organizations").delete().eq("id", scopedOrgId);
  });

  it("counts a reserve stamped as lifetime consumption", async () => {
    const { error } = await db.rpc("reserve_optimization_run", {
      p_org_id: scopedOrgId,
      p_run_id: null,
      p_period_start: FREE_PERIOD_START,
      p_period_end: FREE_PERIOD_END,
      p_included: 1,
      p_lifetime: true,
    });
    expect(error).toBeNull();
    expect(await used()).toBe(1);
  });

  it("excludes an unflagged (paid per-period) reserve", async () => {
    const { error } = await db.rpc("reserve_optimization_run", {
      p_org_id: scopedOrgId,
      p_run_id: null,
      p_period_start: PAID_PERIOD_START,
      p_period_end: PAID_PERIOD_END,
      p_included: 15,
      p_lifetime: false,
    });
    expect(error).toBeNull();
    // Still 1: only the flagged reserve counts.
    expect(await used()).toBe(1);
  });

  it("keeps counting a lifetime reserve after its period is topped up to a paid count", async () => {
    // The upgrade-then-downgrade hole. A mid-period upgrade makes
    // reconcile_plan_grants top the Free period's grant up to the paid count,
    // so any rule that infers "was this a Free period?" from the period's
    // grant total silently reclassifies this spent unit as paid usage and
    // hands the Team a second lifetime run. The flag is written once at
    // reserve time and no grant movement can touch it.
    const { error } = await db.rpc("reconcile_plan_grants", {
      p_org_id: scopedOrgId,
      p_period_start: FREE_PERIOD_START,
      p_period_end: FREE_PERIOD_END,
      p_included_points: 0,
      p_included_runs: 15,
    });
    expect(error).toBeNull();

    const { data: grants } = await db
      .from("optimization_run_ledger")
      .select("units")
      .eq("org_id", scopedOrgId)
      .eq("period_start", FREE_PERIOD_START)
      .in("entry_type", ["grant", "upgrade"]);
    // Precondition: the period really was topped up past Free's count.
    expect(grants!.reduce((s, g) => s + Number(g.units), 0)).toBeGreaterThan(1);

    expect(await used()).toBe(1);
  });

  it("nets a lifetime unit back out when its release carries the flag", async () => {
    const { error } = await db.from("optimization_run_ledger").insert({
      org_id: scopedOrgId,
      entry_type: "release",
      units: 1,
      period_start: FREE_PERIOD_START,
      period_end: FREE_PERIOD_END,
      meta: { lifetime: true },
    });
    expect(error).toBeNull();
    expect(await used()).toBe(0);
  });
});

describe.skipIf(!hasDb)("reconcile_optimization_grant tops up a stale-frozen grant (CR-1, #501)", () => {
  let db: SupabaseClient;
  let scopedOrgId: string;

  const PERIOD_START = "2026-03-01T00:00:00.000Z";
  const PERIOD_END = "2026-04-01T00:00:00.000Z";

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const { data, error } = await db
      .from("organizations")
      .insert({ name: "Reconcile CR-1 test org" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    scopedOrgId = data.id;
  });

  afterAll(async () => {
    if (scopedOrgId) await db.from("organizations").delete().eq("id", scopedOrgId);
  });

  it("raises a frozen-low grant once the freshly computed included value rises", async () => {
    // Simulates the rollover race (CR-1, #501): the new period's grant is
    // first written while `included` reads 0 because an in-flight reserve
    // hasn't released yet.
    const { error: firstCall } = await db.rpc("reconcile_optimization_grant", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included_runs: 0,
    });
    expect(firstCall).toBeNull();

    const { data: balanceBefore } = await db.rpc("optimization_run_balance", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
    });
    expect(Number(balanceBefore)).toBe(0);

    // The in-flight run later releases its unit (no Rollouts), raising
    // `included` back to 1 for this period. Before CR-1's fix this period's
    // grant row would stay frozen at 0 forever (ensure_optimization_grant is
    // insert-once); reconcile_optimization_grant tops it up instead.
    const { error: secondCall } = await db.rpc("reconcile_optimization_grant", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included_runs: 1,
    });
    expect(secondCall).toBeNull();

    const { data: balanceAfter } = await db.rpc("optimization_run_balance", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
    });
    expect(Number(balanceAfter)).toBe(1);
  });

  it("is idempotent: a repeat call at the same included value grants nothing extra", async () => {
    const { error } = await db.rpc("reconcile_optimization_grant", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included_runs: 1,
    });
    expect(error).toBeNull();
    const { data } = await db.rpc("optimization_run_balance", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
    });
    expect(Number(data)).toBe(1);
  });

  it("never claws back when included drops after being granted higher", async () => {
    const { error } = await db.rpc("reconcile_optimization_grant", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included_runs: 0,
    });
    expect(error).toBeNull();
    const { data } = await db.rpc("optimization_run_balance", {
      p_org_id: scopedOrgId,
      p_period_start: PERIOD_START,
    });
    expect(Number(data)).toBe(1); // unchanged — mirrors reconcile_plan_grants
  });
});
