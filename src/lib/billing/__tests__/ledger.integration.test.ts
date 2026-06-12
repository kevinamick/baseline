import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for the Point Ledger SQL (#180): the atomicity, idempotency
 * and append-only guarantees live in Postgres, so they're verified against the
 * real local database, not mocks. Skipped when no local Supabase env is
 * available (CI without a DB); run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run ledger.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";
const NEXT_PERIOD_START = PERIOD_END;
const NEXT_PERIOD_END = "2026-08-01T00:00:00.000Z";

describe.skipIf(!hasDb)("point ledger (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;

  async function createRun(): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async function reserve(
    runId: string | null,
    cost: number,
    opts: { periodStart?: string; periodEnd?: string; included?: number; meta?: object } = {}
  ) {
    const { data, error } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: cost,
      p_period_start: opts.periodStart ?? PERIOD_START,
      p_period_end: opts.periodEnd ?? PERIOD_END,
      p_included: opts.included ?? 1_000,
      p_meta: opts.meta ?? {},
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as { reserved: boolean; balance: number };
  }

  async function balance(periodStart = PERIOD_START): Promise<number> {
    const { data, error } = await db.rpc("point_balance", {
      p_org_id: orgId,
      p_period_start: periodStart,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  async function entries(runId: string) {
    const { data } = await db
      .from("point_ledger")
      .select("entry_type, points, period_start")
      .eq("eval_run_id", runId);
    return data ?? [];
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Ledger Integration Test Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    // public.users FKs auth.users, so provision a real (confirmed) auth user.
    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `ledger-integration-${crypto.randomUUID()}@example.com`,
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
        name: "Ledger test rubric",
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

  afterAll(async () => {
    // org delete cascades the ledger; the synthetic auth user goes separately
    // (auth.users delete cascades the public.users row).
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  it("grants lazily and idempotently: two ensures, one grant row", async () => {
    for (let i = 0; i < 2; i++) {
      const { error } = await db.rpc("ensure_point_grant", {
        p_org_id: orgId,
        p_period_start: PERIOD_START,
        p_period_end: PERIOD_END,
        p_included: 1_000,
      });
      expect(error).toBeNull();
    }
    const { data } = await db
      .from("point_ledger")
      .select("id")
      .eq("org_id", orgId)
      .eq("entry_type", "grant")
      .eq("period_start", PERIOD_START);
    expect(data).toHaveLength(1);
    expect(await balance()).toBe(1_000);
  });

  it("reserve debits the balance and refusal leaves it untouched", async () => {
    const runId = await createRun();
    const ok = await reserve(runId, 300);
    expect(ok).toMatchObject({ reserved: true, balance: 700 });

    const tooBig = await reserve(await createRun(), 10_000);
    expect(tooBig.reserved).toBe(false);
    expect(tooBig.balance).toBe(700);
    expect(await balance()).toBe(700);
  });

  it("concurrent reservations can never jointly exceed the balance", async () => {
    // 700 remaining from the previous test; ten racing 100-point reservations
    // → exactly 7 must win, regardless of interleaving.
    const runIds = await Promise.all(Array.from({ length: 10 }, createRun));
    const results = await Promise.all(runIds.map((id) => reserve(id, 100)));
    const won = results.filter((r) => r.reserved).length;
    expect(won).toBe(7);
    expect(await balance()).toBe(0);
  });

  it("completed runs settle the full reservation; balance is unchanged", async () => {
    // Work in the next period for a clean slate.
    const runId = await createRun();
    const res = await reserve(runId, 250, {
      periodStart: NEXT_PERIOD_START,
      periodEnd: NEXT_PERIOD_END,
      meta: { per_row_cost: 25, row_count: 10, criteria_count: 3 },
    });
    expect(res.reserved).toBe(true);

    const { error } = await db.rpc("settle_eval_run_points", {
      p_run_id: runId,
      p_outcome: "completed",
    });
    expect(error).toBeNull();

    const runEntries = await entries(runId);
    expect(runEntries.map((e) => e.entry_type).sort()).toEqual(["reserve", "settle"]);
    expect(runEntries.find((e) => e.entry_type === "settle")?.points).toBe(250);
    expect(await balance(NEXT_PERIOD_START)).toBe(750);
  });

  it("failed runs settle actuals from scored rows and release the remainder", async () => {
    const runId = await createRun();
    await reserve(runId, 250, {
      periodStart: NEXT_PERIOD_START,
      periodEnd: NEXT_PERIOD_END,
      meta: { per_row_cost: 25, row_count: 10, criteria_count: 3 },
    });

    // 4 of 10 rows scored before the failure.
    const { error: resultsError } = await db.from("eval_run_results").insert(
      Array.from({ length: 4 }, (_, i) => ({
        eval_run_id: runId,
        row_index: i,
        criterion_name: "c1",
        score: 0.5,
        reasoning: "integration",
      }))
    );
    expect(resultsError).toBeNull();

    await db.rpc("settle_eval_run_points", { p_run_id: runId, p_outcome: "failed" });

    const runEntries = await entries(runId);
    const settle = runEntries.find((e) => e.entry_type === "settle");
    const release = runEntries.find((e) => e.entry_type === "release");
    expect(settle?.points).toBe(100); // 4 rows × 25
    expect(release?.points).toBe(150); // unused remainder returned
    // 750 − 250 reserve + 150 release = 650
    expect(await balance(NEXT_PERIOD_START)).toBe(650);
  });

  it("settlement is idempotent across redeliveries", async () => {
    const runId = await createRun();
    await reserve(runId, 100, { periodStart: NEXT_PERIOD_START, periodEnd: NEXT_PERIOD_END });
    for (let i = 0; i < 3; i++) {
      const { error } = await db.rpc("settle_eval_run_points", {
        p_run_id: runId,
        p_outcome: "skipped",
      });
      expect(error).toBeNull();
    }
    const runEntries = await entries(runId);
    expect(runEntries.filter((e) => e.entry_type === "release")).toHaveLength(1);
    expect(await balance(NEXT_PERIOD_START)).toBe(650); // fully released
  });

  it("a run settles against its origin period even after the boundary", async () => {
    // The reservation was made with NEXT_PERIOD columns; its settle/release
    // rows must carry the same period_start, never "now's" period.
    const { data } = await db
      .from("point_ledger")
      .select("entry_type, period_start")
      .eq("org_id", orgId)
      .in("entry_type", ["settle", "release"]);
    expect(data!.length).toBeGreaterThan(0);
    for (const row of data!) {
      expect([PERIOD_START, NEXT_PERIOD_START]).toContain(
        new Date(row.period_start).toISOString()
      );
    }
  });

  it("no rollover: each period's balance is computed only from its own entries", async () => {
    // Period 1 is exhausted (0); period 2 sits at 650 — neither leaks into a
    // brand-new period, which starts at exactly its grant.
    const { error } = await db.rpc("ensure_point_grant", {
      p_org_id: orgId,
      p_period_start: "2026-08-01T00:00:00.000Z",
      p_period_end: "2026-09-01T00:00:00.000Z",
      p_included: 1_000,
    });
    expect(error).toBeNull();
    expect(await balance("2026-08-01T00:00:00.000Z")).toBe(1_000);
  });

  it("the ledger is append-only: updates and deletes are rejected even for the service role", async () => {
    const { data: row } = await db
      .from("point_ledger")
      .select("id, points")
      .eq("org_id", orgId)
      .limit(1)
      .single();

    const { error: updateError } = await db
      .from("point_ledger")
      .update({ points: 999_999 })
      .eq("id", row!.id);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await db
      .from("point_ledger")
      .delete()
      .eq("id", row!.id);
    expect(deleteError).not.toBeNull();

    const { data: after } = await db
      .from("point_ledger")
      .select("points")
      .eq("id", row!.id)
      .single();
    expect(after!.points).toBe(row!.points);
  });

  it("rejects negative reservation costs", async () => {
    await expect(reserve(await createRun(), -5)).rejects.toThrow(/negative cost/);
  });
});
