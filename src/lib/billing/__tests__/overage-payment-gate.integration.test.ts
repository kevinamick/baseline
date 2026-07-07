import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PLANS } from "../plans";

// The seams under test import server modules.
vi.mock("server-only", () => ({}));

// The seams pull in the admin client, which calls createClient at MODULE LOAD and
// throws without a Supabase URL — so a top-level import would crash this whole file
// in the no-DB `test-app` CI job instead of letting describe.skipIf skip it. Import
// them dynamically in beforeAll (which doesn't run for a skipped suite), mirroring
// the other billing *.integration.test.ts. Types stay via `typeof import(...)`.
type ReserveEvalRunPoints = (typeof import("../ledger"))["reserveEvalRunPoints"];
type ReserveOptimizationPoints = (typeof import("../allowance"))["reserveOptimizationPoints"];

/**
 * Integration tests for the payment-failing overage gate (#215). The behavior
 * lives in the reserve SEAMS (reserveEvalRunPoints / reserveOptimizationRun),
 * which suppress the plan's overage rates when `paymentMethodFailing` is true so
 * the underlying RPC hard-stops at the included allotment — verified against the
 * real local database (the seams resolve the plan via getBillingState and read
 * the failing signals from `customers`). Skipped when no local Supabase env is
 * available; run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run overage-payment-gate.integration
 *
 * Needs STRIPE_PRICE_BUILDER set so a seeded subscription resolves to a paid plan
 * (Free has no overage rates, so the gate would be a no-op).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const builderPrice = process.env.STRIPE_PRICE_BUILDER;
const hasDb = Boolean(url && serviceKey && builderPrice);

const PERIOD_START = "2026-06-01T00:00:00.000Z";
const PERIOD_END = "2026-07-01T00:00:00.000Z";
const BUILDER_INCLUDED = PLANS.builder.includedEvalPoints;
const WITHIN_COST = 100; // comfortably inside any plan's included allotment
const BEYOND_COST = BUILDER_INCLUDED + 50_000; // exceeds builder's included (and Free's)
const BIG_CAP = 10_000_000; // so healthy overage always fits the cap

describe.skipIf(!hasDb)("overage payment-failing gate (#215, integration)", () => {
  let db: SupabaseClient;
  let reserveEvalRunPoints: ReserveEvalRunPoints;
  let reserveOptimizationPoints: ReserveOptimizationPoints;
  const createdOrgs: string[] = [];
  const createdUsers: string[] = [];

  /** A fresh org with a builder subscription mirror, an overage cap, and the given
   *  payment signals — so each scenario's ledger is isolated. */
  async function setupOrg(opts: {
    status: string;
    managedFailedAt?: string | null;
  }): Promise<{ orgId: string; userId: string; rubricId: string; connectionId: string }> {
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({ name: "215 gate test org" })
      .select("id, created_at")
      .single();
    if (orgErr) throw new Error(orgErr.message);
    const orgId = org.id;
    createdOrgs.push(orgId);

    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: `gate-215-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authErr) throw new Error(authErr.message);
    const userId = authUser.user.id;
    createdUsers.push(userId);
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });

    // Subscription mirror → getBillingState resolves the (paid) plan + period.
    const { error: custErr } = await db.from("customers").insert({
      org_id: orgId,
      stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
      status: opts.status,
      stripe_price_id: builderPrice,
      current_period_start: PERIOD_START,
      current_period_end: PERIOD_END,
      managed_payment_failed_at: opts.managedFailedAt ?? null,
    });
    if (custErr) throw new Error(custErr.message);

    const { error: capErr } = await db
      .from("billing_settings")
      .upsert({ org_id: orgId, overage_cap_usd: BIG_CAP });
    if (capErr) throw new Error(capErr.message);

    const { data: rubric, error: rubricErr } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "gate rubric",
        scenario_description: "i",
        expected_outcome: "i",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    if (rubricErr) throw new Error(rubricErr.message);

    const { data: conn, error: connErr } = await db
      .from("connections")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "gate agent",
        kind: "agent",
        endpoint: "https://example.test/agent",
        response_path: "output",
      })
      .select("id")
      .single();
    if (connErr) throw new Error(connErr.message);

    return { orgId, userId, rubricId: rubric.id, connectionId: conn.id };
  }

  async function newEvalRun(orgId: string, userId: string, rubricId: string): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async function newOptRun(
    orgId: string,
    userId: string,
    rubricId: string,
    connectionId: string,
  ): Promise<string> {
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

  const meta = { row_count: 1, criteria_count: 1, per_row_cost: 1 };

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    ({ reserveEvalRunPoints } = await import("../ledger"));
    ({ reserveOptimizationPoints } = await import("../allowance"));
  });

  afterAll(async () => {
    for (const orgId of createdOrgs) await db.from("organizations").delete().eq("id", orgId);
    for (const userId of createdUsers) await db.auth.admin.deleteUser(userId);
  });

  it("healthy + active: a run beyond included digs into overage (reserved)", async () => {
    const { orgId, userId, rubricId } = await setupOrg({ status: "active" });
    const r = await reserveEvalRunPoints(orgId, await newEvalRun(orgId, userId, rubricId), BEYOND_COST, meta);
    expect(r.paymentFailing).toBe(false);
    expect(r.reserved).toBe(true);
  });

  it("managed_payment_failed_at set: included admitted, overage refused", async () => {
    const { orgId, userId, rubricId } = await setupOrg({
      status: "active",
      managedFailedAt: "2026-06-02T00:00:00.000Z",
    });

    // Prepaid/included still works.
    const within = await reserveEvalRunPoints(orgId, await newEvalRun(orgId, userId, rubricId), WITHIN_COST, meta);
    expect(within.paymentFailing).toBe(true);
    expect(within.reserved).toBe(true);

    // Overage is suppressed → hard-stop at the included balance.
    const beyond = await reserveEvalRunPoints(orgId, await newEvalRun(orgId, userId, rubricId), BEYOND_COST, meta);
    expect(beyond.paymentFailing).toBe(true);
    expect(beyond.reserved).toBe(false);
  });

  it("past_due subscription: overage refused", async () => {
    const { orgId, userId, rubricId } = await setupOrg({ status: "past_due" });
    const beyond = await reserveEvalRunPoints(orgId, await newEvalRun(orgId, userId, rubricId), BEYOND_COST, meta);
    expect(beyond.paymentFailing).toBe(true);
    expect(beyond.reserved).toBe(false);
  });

  it("recovery: clearing the failed signal reopens overage automatically", async () => {
    const { orgId, userId, rubricId } = await setupOrg({
      status: "active",
      managedFailedAt: "2026-06-02T00:00:00.000Z",
    });

    const blocked = await reserveEvalRunPoints(orgId, await newEvalRun(orgId, userId, rubricId), BEYOND_COST, meta);
    expect(blocked.reserved).toBe(false);

    // Invoice paid / card fixed: the webhook nulls the mirror flag.
    await db.from("customers").update({ managed_payment_failed_at: null }).eq("org_id", orgId);

    const restored = await reserveEvalRunPoints(orgId, await newEvalRun(orgId, userId, rubricId), BEYOND_COST, meta);
    expect(restored.paymentFailing).toBe(false);
    expect(restored.reserved).toBe(true);
  });

  it("optimization overage runs honor the same gate (ADR-0016: points meter)", async () => {
    // Past the included run-count, an optimization run meters Eval Points
    // (reserveOptimizationPoints) — so it rides the SAME #215 gate as eval runs:
    // a failing card suppresses overage rates and the points reserve hard-stops.
    const failing = await setupOrg({
      status: "active",
      managedFailedAt: "2026-06-02T00:00:00.000Z",
    });
    const refused = await reserveOptimizationPoints(
      failing.orgId,
      await newOptRun(failing.orgId, failing.userId, failing.rubricId, failing.connectionId),
      BEYOND_COST,
      { criteria_count: 1, budget_rollouts: 10, per_rollout_cost: 1 },
    );
    expect(refused.paymentFailing).toBe(true);
    expect(refused.reserved).toBe(false);

    const healthy = await setupOrg({ status: "active" });
    const allowed = await reserveOptimizationPoints(
      healthy.orgId,
      await newOptRun(healthy.orgId, healthy.userId, healthy.rubricId, healthy.connectionId),
      BEYOND_COST,
      { criteria_count: 1, budget_rollouts: 10, per_rollout_cost: 1 },
    );
    expect(allowed.paymentFailing).toBe(false);
    expect(allowed.reserved).toBe(true);
  });
});
