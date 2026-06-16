import { describe, it, expect, beforeAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
// Action modules pull in the Stripe wrapper at import; stub it so the read actions
// can be exercised against the real DB without a Stripe account.
vi.mock("@/lib/stripe", () => ({ stripe: {} }));

// The read actions resolve the caller via getAuthContext; pin it to the test org
// so per-surface denial can be verified through the real action code path.
const auth = vi.hoisted(() => ({
  ctx: { userId: "", orgId: "", canWrite: true, role: "admin" as const },
}));
vi.mock("@/lib/auth/context", () => ({
  getAuthContext: vi.fn(async () => auth.ctx),
}));

/**
 * Integration tests for the Retention Window (#187, ADR-0008). The aging
 * soft-delete, the grace-period purge invariant, downgrade/re-upgrade round-trip,
 * and per-surface denial live in Postgres + the read actions, so they're verified
 * against the real local DB. Skipped without local Supabase env:
 *
 *   set -a; source .env.local; set +a; npx vitest run retention.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const cutoffFor = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

describe.skipIf(!hasDb)("retention window (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;
  let connectionId: string;

  async function newOrgWithUser(name: string): Promise<{ orgId: string; userId: string }> {
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({ name })
      .select("id")
      .single();
    if (orgErr) throw new Error(orgErr.message);
    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: `retention-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authErr) throw new Error(authErr.message);
    await db.from("users").upsert({ id: authUser.user.id }, { onConflict: "id" });
    return { orgId: org.id as string, userId: authUser.user.id };
  }

  async function newEvalRun(opts: {
    rubric?: string;
    createdAt?: string;
    status?: string;
    deletedAt?: string | null;
  }): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({
        created_by: userId,
        rubric_id: opts.rubric ?? rubricId,
        status: opts.status ?? "completed",
        created_at: opts.createdAt ?? new Date().toISOString(),
        deleted_at: opts.deletedAt ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  async function newOptRun(opts: {
    createdAt?: string;
    status?: string;
    deletedAt?: string | null;
  }): Promise<string> {
    const { data, error } = await db
      .from("optimization_runs")
      .insert({
        org_id: orgId,
        created_by: userId,
        connection_id: connectionId,
        rubric_id: rubricId,
        budget_rollouts: 10,
        max_iters: 1,
        status: opts.status ?? "completed",
        created_at: opts.createdAt ?? new Date().toISOString(),
        deleted_at: opts.deletedAt ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  async function deletedAt(table: string, id: string): Promise<string | null> {
    const { data } = await db.from(table).select("deleted_at").eq("id", id).maybeSingle();
    return (data?.deleted_at as string | null) ?? null;
  }

  async function exists(table: string, id: string): Promise<boolean> {
    const { data } = await db.from(table).select("id").eq("id", id).maybeSingle();
    return data != null;
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    ({ orgId, userId } = await newOrgWithUser("Retention Integration Org"));
    auth.ctx.orgId = orgId;
    auth.ctx.userId = userId;

    const { data: rubric, error: rubricErr } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Retention rubric",
        scenario_description: "integration",
        expected_outcome: "integration",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    if (rubricErr) throw new Error(rubricErr.message);
    rubricId = rubric.id;

    const { data: conn, error: connErr } = await db
      .from("connections")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Retention agent",
        kind: "agent",
        endpoint: "https://example.test/agent",
        response_path: "output",
      })
      .select("id")
      .single();
    if (connErr) throw new Error(connErr.message);
    connectionId = conn.id;
  });

  it("soft-deletes only settled runs past the cutoff, sparing in-window and active runs", async () => {
    const oldDone = await newEvalRun({ createdAt: ago(100) });
    const oldRunning = await newEvalRun({ createdAt: ago(100), status: "running" });
    const recent = await newEvalRun({ createdAt: ago(5) });
    const oldOpt = await newOptRun({ createdAt: ago(120) });

    const { data, error } = await db.rpc("expire_runs_before", {
      p_org_id: orgId,
      p_cutoff: cutoffFor(90),
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    expect(Number(row.eval_expired)).toBe(1); // only oldDone
    expect(Number(row.opt_expired)).toBe(1); // oldOpt

    expect(await deletedAt("eval_runs", oldDone)).not.toBeNull();
    expect(await deletedAt("eval_runs", oldRunning)).toBeNull(); // active spared
    expect(await deletedAt("eval_runs", recent)).toBeNull(); // in-window spared
    expect(await deletedAt("optimization_runs", oldOpt)).not.toBeNull();

    // Idempotent: a second sweep re-stamps nothing.
    const { data: again } = await db.rpc("expire_runs_before", {
      p_org_id: orgId,
      p_cutoff: cutoffFor(90),
    });
    const againRow = Array.isArray(again) ? again[0] : again;
    expect(Number(againRow.eval_expired)).toBe(0);
    expect(Number(againRow.opt_expired)).toBe(0);
  });

  it("purges only rows soft-deleted past the grace window — never live or recent data", async () => {
    const eligible = await newEvalRun({ createdAt: ago(200), deletedAt: ago(40) });
    const inGrace = await newEvalRun({ createdAt: ago(200), deletedAt: ago(10) });
    const live = await newEvalRun({ createdAt: ago(200), deletedAt: null }); // adversarial: old but not soft-deleted
    const eligibleOpt = await newOptRun({ createdAt: ago(400), deletedAt: ago(45) });

    const { data, error } = await db.rpc("purge_expired_runs", { p_grace_days: 30 });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    expect(Number(row.eval_purged)).toBeGreaterThanOrEqual(1);

    expect(await exists("eval_runs", eligible)).toBe(false); // purged
    expect(await exists("optimization_runs", eligibleOpt)).toBe(false); // purged
    expect(await exists("eval_runs", inGrace)).toBe(true); // within grace — kept
    expect(await exists("eval_runs", live)).toBe(true); // never soft-deleted — never purged
  });

  it("restores soft-deleted runs that fall back inside a widened window (re-upgrade)", async () => {
    // Downgrade to a 90-day window soft-deletes a 100-day-old run...
    const run = await newEvalRun({ createdAt: ago(100) });
    await db.rpc("expire_runs_before", { p_org_id: orgId, p_cutoff: cutoffFor(90) });
    expect(await deletedAt("eval_runs", run)).not.toBeNull();

    // ...re-upgrading to the 3-year window brings it back (created_at >= cutoff).
    const { data, error } = await db.rpc("restore_runs_since", {
      p_org_id: orgId,
      p_cutoff: cutoffFor(1_095),
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    expect(Number(row.eval_restored)).toBeGreaterThanOrEqual(1);
    expect(await deletedAt("eval_runs", run)).toBeNull();
  });

  it("lists an org as a candidate only while it holds live runs", async () => {
    const fresh = await newOrgWithUser("Retention Candidate Org");
    const { data: r } = await db
      .from("rubrics")
      .insert({
        org_id: fresh.orgId,
        created_by: fresh.userId,
        name: "c",
        scenario_description: "x",
        expected_outcome: "x",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    const { data: run } = await db
      .from("eval_runs")
      .insert({ created_by: fresh.userId, rubric_id: r!.id, status: "completed" })
      .select("id")
      .single();

    const candidates = async () => {
      const { data } = await db.rpc("retention_candidate_orgs");
      return (data ?? []).map((x: unknown) =>
        typeof x === "string" ? x : (x as { retention_candidate_orgs: string }).retention_candidate_orgs,
      );
    };

    expect(await candidates()).toContain(fresh.orgId);

    await db.from("eval_runs").update({ deleted_at: new Date().toISOString() }).eq("id", run!.id);
    expect(await candidates()).not.toContain(fresh.orgId);
  });

  it("sweeps against the SUBSCRIBED plan — payment trouble never shrinks the window", async () => {
    const priceScale = process.env.STRIPE_PRICE_SCALE;
    const priceBuilder = process.env.STRIPE_PRICE_BUILDER;
    if (!priceScale || !priceBuilder) return; // env-gated like the e2e plan specs
    const { sweepRetentionForOrg } = await import("@/lib/billing/retention");

    const swept = await newOrgWithUser("Retention Past-Due Org");
    const { data: rb } = await db
      .from("rubrics")
      .insert({
        org_id: swept.orgId,
        created_by: swept.userId,
        name: "pd",
        scenario_description: "x",
        expected_outcome: "x",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    const { data: run } = await db
      .from("eval_runs")
      .insert({
        created_by: swept.userId,
        rubric_id: rb!.id,
        status: "completed",
        created_at: ago(200), // out of Builder's 90d, inside Scale's 3y
      })
      .select("id")
      .single();
    const runId = run!.id as string;

    // past_due Scale subscription: getBillingState floors `plan` to free, but
    // retention must follow the subscribed Scale window — so nothing is hidden.
    await db.from("customers").insert({
      org_id: swept.orgId,
      stripe_customer_id: `cus_pd_${swept.orgId}`,
      status: "past_due",
      stripe_price_id: priceScale,
      current_period_start: ago(5),
      current_period_end: new Date(Date.now() + 25 * DAY_MS).toISOString(),
    });
    await sweepRetentionForOrg(swept.orgId);
    expect(await deletedAt("eval_runs", runId)).toBeNull(); // Scale window kept

    // Once the subscription is genuinely canceled, the Free window applies and the
    // 200-day run ages out on the next sweep.
    await db.from("customers").update({ status: "canceled" }).eq("org_id", swept.orgId);
    await sweepRetentionForOrg(swept.orgId);
    expect(await deletedAt("eval_runs", runId)).not.toBeNull();
  });

  it("hides a soft-deleted run from every read surface (#187 — per-surface denial)", async () => {
    const { getEvalRuns, getEvalRunDetails, getRunCriteriaBreakdown, getEvalRunComparison } =
      await import("@/app/actions/eval-runs");
    const { listOptimizationRuns, getOptimizationRun } = await import("@/app/actions/optimizations");

    // A visible run to compare against, and the one we'll soft-delete.
    const keeper = await newEvalRun({ createdAt: ago(1) });
    const doomed = await newEvalRun({ createdAt: ago(1) });
    await db.from("eval_run_results").insert([
      { eval_run_id: doomed, row_index: 0, criterion_name: "c1", score: 1, reasoning: "r" },
    ]);
    await db.from("eval_run_rows").insert([
      { eval_run_id: doomed, row_index: 0, user_input: "u", agent_output: "a" },
    ]);
    await db.from("eval_run_rows").insert([
      { eval_run_id: keeper, row_index: 0, user_input: "u", agent_output: "a" },
    ]);
    const doomedOpt = await newOptRun({ createdAt: ago(1) });

    // Visible before soft-deletion.
    expect((await getEvalRuns(rubricId)).map((r) => r.id)).toContain(doomed);
    expect(await getEvalRunDetails(doomed)).not.toBeNull();
    expect((await listOptimizationRuns()).map((r) => r.id)).toContain(doomedOpt);
    expect(await getOptimizationRun(doomedOpt)).not.toBeNull();

    // Soft-delete both runs.
    const now = new Date().toISOString();
    await db.from("eval_runs").update({ deleted_at: now }).eq("id", doomed);
    await db.from("optimization_runs").update({ deleted_at: now }).eq("id", doomedOpt);

    // Gone from list, detail, breakdown, comparison, optimization list + detail.
    expect((await getEvalRuns(rubricId)).map((r) => r.id)).not.toContain(doomed);
    expect(await getEvalRunDetails(doomed)).toBeNull();
    expect(await getRunCriteriaBreakdown(doomed)).toEqual([]);
    expect(await getEvalRunComparison(doomed, keeper)).toBeNull();
    expect((await listOptimizationRuns()).map((r) => r.id)).not.toContain(doomedOpt);
    expect(await getOptimizationRun(doomedOpt)).toBeNull();

    // And from the dashboard RPC.
    const { data: dash } = await db.rpc("dashboard_runs", {
      p_org_id: orgId,
      p_window_start: ago(3650),
      p_n: 100,
    });
    expect((dash ?? []).map((d: { id: string }) => d.id)).not.toContain(doomed);
  });
});
