import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PLANS } from "../plans";

vi.mock("server-only", () => ({}));

// gateScheduledRunBilling pulls in the admin client (createClient at module load,
// throws without a Supabase URL) — import dynamically in beforeAll so the no-DB
// `test-app` CI job skips this file instead of crashing on import.
type GateFn = (typeof import("../claim-gate"))["gateScheduledRunBilling"];

/**
 * Integration tests for the schedule claim-time billing gate (#199), against the
 * real local DB (it runs the actual reserve + seat seams). Skipped without a local
 * Supabase env. Needs STRIPE_PRICE_BUILDER so a seeded subscription resolves to a
 * paid plan with a known period.
 *
 *   set -a; source .env.local; set +a; npx vitest run claim-gate.integration
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const builderPrice = process.env.STRIPE_PRICE_BUILDER;
const hasDb = Boolean(url && serviceKey && builderPrice);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";
const BUILDER_INCLUDED = PLANS.builder.includedEvalPoints;

describe.skipIf(!hasDb)("schedule claim-time billing gate (#199, integration)", () => {
  let db: SupabaseClient;
  let gateScheduledRunBilling: GateFn;
  const createdOrgs: string[] = [];
  const createdUsers: string[] = [];

  async function newUser(): Promise<string> {
    const { data, error } = await db.auth.admin.createUser({
      email: `claimgate-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    const userId = data.user.id;
    createdUsers.push(userId);
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });
    return userId;
  }

  /** Org + owner + a 1-criterion rubric, with an optional subscription mirror. */
  async function setupOrg(opts: {
    status?: string; // omit → no customers row (Free, anniversary period)
  }): Promise<{ orgId: string; userId: string; rubricId: string }> {
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({ name: "199 claim-gate org" })
      .select("id")
      .single();
    if (orgErr) throw new Error(orgErr.message);
    const orgId = org.id;
    createdOrgs.push(orgId);

    const userId = await newUser();
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    if (opts.status) {
      const { error: custErr } = await db.from("customers").insert({
        org_id: orgId,
        stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
        status: opts.status,
        stripe_price_id: builderPrice,
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
      });
      if (custErr) throw new Error(custErr.message);
    }

    const { data: rubric, error: rubricErr } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "claim-gate rubric",
        scenario_description: "i",
        expected_outcome: "i",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }], // 1 criterion → 15 pts/row
      })
      .select("id")
      .single();
    if (rubricErr) throw new Error(rubricErr.message);
    return { orgId, userId, rubricId: rubric.id };
  }

  // A run with `rows` input rows. The gate is schedule-agnostic (the worker decides
  // WHICH runs to gate by schedule_id; gateScheduledRunBilling reserves for whatever
  // run it's handed), so the FK-bearing schedule_id isn't needed here.
  async function newScheduledRun(userId: string, rubricId: string, rows: number): Promise<string> {
    const { data: run, error } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await db.from("eval_run_rows").insert(
      Array.from({ length: rows }, (_, i) => ({
        eval_run_id: run.id,
        row_index: i,
        user_input: `in-${i}`,
        agent_output: `out-${i}`,
      })),
    );
    return run.id;
  }

  async function reserveCount(runId: string): Promise<number> {
    const { count } = await db
      .from("point_ledger")
      .select("id", { count: "exact", head: true })
      .eq("eval_run_id", runId)
      .eq("entry_type", "reserve");
    return count ?? 0;
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    ({ gateScheduledRunBilling } = await import("../claim-gate"));
  });

  afterAll(async () => {
    for (const orgId of createdOrgs) await db.from("organizations").delete().eq("id", orgId);
    for (const userId of createdUsers) await db.auth.admin.deleteUser(userId);
  });

  it("refuses a scheduled run with insufficient Points", async () => {
    const { orgId, userId, rubricId } = await setupOrg({ status: "active" });

    // Drain the included allotment (no overage cap → hard-stop at included).
    const { data: drainRun } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: drainRun!.id,
      p_cost: BUILDER_INCLUDED,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: BUILDER_INCLUDED,
      p_meta: {},
      p_point_unit_usd: null,
      p_run_unit_usd: null,
    });

    const runId = await newScheduledRun(userId, rubricId, 1);
    const result = await gateScheduledRunBilling(runId);
    expect(result).toEqual({ allowed: false, reason: "insufficient_points" });
    expect(await reserveCount(runId)).toBe(0); // refused → no reserve held
  });

  it("refuses a scheduled run for a seat-cap-violated Team", async () => {
    // Ended subscription floors to Free (seatLimit 1); a second member violates it.
    const { orgId, userId, rubricId } = await setupOrg({ status: "canceled" });
    const second = await newUser();
    await db.from("memberships").insert({ org_id: orgId, user_id: second, role: "admin" });

    const runId = await newScheduledRun(userId, rubricId, 1);
    const result = await gateScheduledRunBilling(runId);
    expect(result).toEqual({ allowed: false, reason: "seat_cap" });
    expect(await reserveCount(runId)).toBe(0);

    // The seat-cap notification throttle row was claimed (a real timestamptz
    // period_start — a synthetic key would have failed the upsert and dropped it).
    const { count: notified } = await db
      .from("billing_notifications")
      .select("org_id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("kind", "seat_cap");
    expect(notified).toBe(1);
  });

  it("admits a scheduled run with budget and holds exactly one reserve", async () => {
    const { userId, rubricId } = await setupOrg({ status: "active" });
    const runId = await newScheduledRun(userId, rubricId, 2);
    const result = await gateScheduledRunBilling(runId);
    expect(result).toEqual({ allowed: true });
    expect(await reserveCount(runId)).toBe(1);
  });

  it("is idempotent: an already-reserved run passes through with no second reserve", async () => {
    const { orgId, userId, rubricId } = await setupOrg({ status: "active" });
    const runId = await newScheduledRun(userId, rubricId, 1);

    // Pre-reserve (simulates an interactive run reserved at creation).
    await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: 15,
      p_period_start: PERIOD_START,
      p_period_end: PERIOD_END,
      p_included: BUILDER_INCLUDED,
      p_meta: {},
      p_point_unit_usd: null,
      p_run_unit_usd: null,
    });

    const result = await gateScheduledRunBilling(runId);
    expect(result).toEqual({ allowed: true });
    expect(await reserveCount(runId)).toBe(1); // no double reserve
  });
});
