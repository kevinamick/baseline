import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeAdminClient } from "./constants";
import { PLANS } from "../src/lib/billing/plans";

/**
 * Single (interactive) eval run on a managed key must be CHARGED (#358).
 *
 * A paid Team with no BYO key runs the judge on the managed platform key, so the
 * run's managed-token spend must be metered in dollars and billed. The worker can
 * only meter a run that carries a managed-spend RESERVE row — `createManagedMeter`
 * returns null without one, the judge meter is never built, nothing accrues, and
 * the spend is never invoiced. So the reserve row is the app-side precondition for
 * the run ever being charged.
 *
 * The e2e stack runs no worker (no managed tokens actually burn), so this asserts
 * the boundary the app owns: a real interactive eval run, created through the run
 * dialog by a managed Builder Team, must leave a `reserve` entry in
 * managed_spend_ledger for that run. Its ABSENCE is exactly "managed spend isn't
 * charged" (#358).
 *
 * Provisions its OWN paid (Builder) org so its ledger churn can't leak into the
 * shared fixtures. Teardown is one org delete (FK cascade clears the ledger).
 */

const PASSWORD = "password123";
const INCLUDED = PLANS.builder.includedEvalPoints;
const RUBRIC_NAME = "Managed eval charge spec rubric";

// The reserve test (the chargeable precondition) is app-only and runs in CI. The two
// tests that need the worker to actually execute the run — accrue (which burns real
// managed Anthropic tokens) and the fail-closed guard — are opt-in via E2E_WORKER_RUNNING
// (set it locally with a worker pointed at this stack). In CI those two are covered
// deterministically by the worker unit test (worker/src/worker.test.ts — the guard) and
// the app unit tests (the reserve decision); the e2e here adds the real end-to-end proof.
const WORKER_RUNNING = !!process.env.E2E_WORKER_RUNNING;
const needsWorker = { skip: !WORKER_RUNNING } as const;

test.describe.configure({ mode: "serial" });

test.describe("Single managed eval run is charged (#358)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let email: string;
  let periodStart: string;
  let periodEnd: string;
  let rubricId: string;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  async function newPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState });
    return ctx.newPage();
  }

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;
    email = `mgd-charge-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Managed Eval Charge Spec Team" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    // Builder subscription via a seeded mirror row → paid, managed mode (no BYO key).
    periodStart = new Date(Date.now() - 5 * 86_400_000).toISOString();
    periodEnd = new Date(Date.now() + 25 * 86_400_000).toISOString();
    const { error: mirrorError } = await db.from("customers").insert({
      org_id: orgId,
      stripe_customer_id: `cus_mgdcharge_${orgId}`,
      stripe_subscription_id: `sub_mgdcharge_${orgId}`,
      status: "active",
      stripe_price_id: process.env.STRIPE_PRICE_BUILDER,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      mirror_event_at: new Date().toISOString(),
      email,
    });
    if (mirrorError) throw new Error(mirrorError.message);

    const { data: rubric, error: rubricError } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: RUBRIC_NAME,
        scenario_description: "Managed eval charge spec scenario",
        expected_outcome: "Routed correctly",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "Routing accuracy", weight: 1, steps: ["Right queue?"] }],
      })
      .select("id")
      .single();
    if (rubricError) throw new Error(rubricError.message);
    rubricId = rubric.id as string;

    // Point grant so the points check never blocks — the gate under test is the
    // managed-spend reservation, not Eval Points.
    const { error: grantError } = await db.rpc("ensure_point_grant", {
      p_org_id: orgId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
    });
    if (grantError) throw new Error(grantError.message);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    storageState = await ctx.storageState();
    await ctx.close();
  });

  test.afterAll(async () => {
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  test("a single managed eval run reserves managed spend (the chargeable precondition)", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_NAME }).click();
    await page.getByRole("button", { name: "Run eval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("#user-input-0").fill("Where does this ticket go?");
    await dialog.locator("#agent-output-0").fill("Queue: billing, P2");
    await dialog.getByRole("button", { name: "Run eval" }).click();
    // The dialog closes on a successful create (the run is queued).
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.context().close();

    // The run now exists for this org's rubric.
    const { data: run, error: runErr } = await db
      .from("eval_runs")
      .select("id")
      .eq("rubric_id", rubricId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    expect(run?.id, "an eval run was created").toBeTruthy();

    // The chargeable precondition: a managed-spend reserve row for this run. Without
    // it the worker builds no meter and the managed spend is never charged (#358).
    const { data: reserve, error: ledgerErr } = await db
      .from("managed_spend_ledger")
      .select("amount_usd, markup_pct, cap_usd")
      .eq("eval_run_id", run!.id)
      .eq("entry_type", "reserve")
      .maybeSingle();
    if (ledgerErr) throw new Error(ledgerErr.message);

    expect(
      reserve,
      "a managed single eval run must reserve managed spend so the worker can meter + charge it (#358)"
    ).not.toBeNull();
    expect(Number(reserve!.amount_usd)).toBeGreaterThan(0);
  });

  test("a single managed eval run accrues managed spend on the ledger (the actual charge)", async ({
    browser,
  }) => {
    test.skip(
      needsWorker.skip,
      "needs a worker pointed at this stack + a real managed key (burns tokens); set E2E_WORKER_RUNNING. Reserve→meter logic is unit-tested in CI.",
    );
    // Requires a worker running against this stack (it makes the managed judge
    // call + accrues). The run dialog creates the run; the worker meters it.
    const page = await newPage(browser);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_NAME }).click();
    await page.getByRole("button", { name: "Run eval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("#user-input-0").fill("Where does this ticket go?");
    await dialog.locator("#agent-output-0").fill("Queue: billing, P2");
    await dialog.getByRole("button", { name: "Run eval" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.context().close();

    // The exact run this test just created.
    const { data: created, error: runErr } = await db
      .from("eval_runs")
      .select("id")
      .eq("rubric_id", rubricId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    const runId = created!.id as string;

    // The worker should reach a terminal state for it.
    await expect
      .poll(
        async () => {
          const { data } = await db
            .from("eval_runs")
            .select("status")
            .eq("id", runId)
            .maybeSingle();
          return data?.status as string | undefined;
        },
        { timeout: 90_000, intervals: [2_000] }
      )
      .toBe("completed");

    // And the managed judge call must have accrued an `accrue` row — the spend the
    // Billing usage view surfaces. Its absence is #358: "managed spend never showed
    // up on the ledger."
    const { data: accruals, error: accErr } = await db
      .from("managed_spend_ledger")
      .select("amount_usd, call_kind")
      .eq("eval_run_id", runId)
      .eq("entry_type", "accrue");
    if (accErr) throw new Error(accErr.message);

    expect(
      (accruals ?? []).length,
      "a completed managed eval run must accrue managed spend to the ledger (#358)"
    ).toBeGreaterThan(0);
    expect(accruals!.every((a) => a.call_kind === "judge")).toBe(true);
    expect(accruals!.reduce((s, a) => s + Number(a.amount_usd), 0)).toBeGreaterThan(0);
  });

  test("a managed judge with no managed-spend reservation fails closed — never judges unmetered (#358)", async () => {
    test.skip(
      needsWorker.skip,
      "needs a worker pointed at this stack; set E2E_WORKER_RUNNING. The guard's real code path is unit-tested in CI (worker/src/worker.test.ts).",
    );
    // The #358 divergence: the worker resolves the judge to the MANAGED key (the
    // Team is paid — customers.status active — with no usable BYO key) while NO
    // managed-spend reserve exists (the app skipped it — a price/plan the app floors
    // to Free, an unusable BYO-key row, or any app↔worker disagreement). With no
    // reserve, createManagedMeter returns null; without a fail-closed guard the
    // judge runs on the managed key UNMETERED and the run completes with nothing on
    // the ledger — exactly "managed spend never showed up." Build that state
    // directly: a queued run with a POINT reserve (so it's fundable) but NO managed
    // reserve, then let the worker claim it.
    const { data: run, error: insErr } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    const runId = run.id as string;

    const { error: ptErr } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: 1,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
      p_meta: { e2e: "managed-eval-charge no-reserve divergence" },
    });
    if (ptErr) throw new Error(ptErr.message);

    const { error: rowErr } = await db.from("eval_run_rows").insert({
      eval_run_id: runId,
      row_index: 0,
      user_input: "Where does this ticket go?",
      agent_output: "Queue: billing, P2",
    });
    if (rowErr) throw new Error(rowErr.message);

    // No reserveManagedSpend — this is the divergence. Hand it to the worker.
    const { error: qErr } = await db.rpc("enqueue_eval_run", { run_id: runId });
    if (qErr) throw new Error(qErr.message);

    // The worker must reach a TERMINAL state (queued/running are transient).
    await expect
      .poll(
        async () => {
          const { data } = await db
            .from("eval_runs")
            .select("status")
            .eq("id", runId)
            .maybeSingle();
          const s = data?.status as string | undefined;
          return s === "completed" || s === "failed" || s === "skipped";
        },
        { timeout: 90_000, intervals: [2_000] }
      )
      .toBe(true);

    const { data: settled } = await db
      .from("eval_runs")
      .select("status, error_message")
      .eq("id", runId)
      .maybeSingle();
    const { data: accruals } = await db
      .from("managed_spend_ledger")
      .select("id")
      .eq("eval_run_id", runId)
      .eq("entry_type", "accrue");

    // The invariant: a managed judge with no reserve must NOT silently judge and
    // complete. It must fail closed (and accrue nothing). Before the guard the run
    // completes unmetered — this assertion is RED.
    expect(
      settled?.status,
      "a managed judge run with no reservation must fail closed, not complete unmetered (#358)"
    ).toBe("failed");
    expect(settled?.error_message ?? "").toMatch(/managed[- ]spend reservation|refusing to run/i);
    expect((accruals ?? []).length).toBe(0);
  });
});
