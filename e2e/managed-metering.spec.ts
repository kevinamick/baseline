import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeAdminClient, mailpitHasEmail } from "./constants";
import { PLANS } from "../src/lib/billing/plans";

/**
 * Managed Key gateway metering & Managed Spend Cap (#185). A paid Team with no
 * BYO key runs on the managed platform key — metered in dollars and bounded by
 * the Managed Spend Cap. This spec drives the customer-facing surfaces:
 *   - the Billing page shows the Managed Spend Cap (plan default, raisable) and
 *     a usage view of accrued managed spend;
 *   - at the cap, a run is refused with an inline managed-cap message and the
 *     Contributor email (Mailpit).
 *
 * The e2e stack doesn't score runs against a live provider (no managed tokens
 * actually burn), so accruals are SEEDED with the same accrue RPC the worker
 * uses — the assertions are the deterministic app-side ones: the cap UI, the
 * usage view, and the pre-run refusal once accrued spend reaches the cap.
 *
 * Provisions its OWN paid (Builder) org so its ledger churn can't leak into the
 * shared fixtures. Teardown is one org delete (FK cascade clears the ledger,
 * which the append-only grants would otherwise forbid).
 */

const PASSWORD = "password123";
const INCLUDED = PLANS.builder.includedEvalPoints;
const DEFAULT_CAP = PLANS.builder.defaultManagedSpendCapUsd!; // 25
const CAP_USD = 1; // lowered via the UI so a tiny seeded accrual reaches it
const RUBRIC_NAME = "Managed metering spec rubric";
const SEED_MODEL = "claude-haiku-4-5-20251001";

test.describe.configure({ mode: "serial" });

test.describe("Managed Spend Cap (#185)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let email: string;
  let periodStart: string;
  let periodEnd: string;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  // Seed one managed accrual the way the worker does: a run with a point
  // reservation (so accrue derives the period), then accrue the dollar amount.
  async function seedAccrual(amountUsd: number) {
    const { data: run, error: runErr } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: await rubricId() })
      .select("id")
      .single();
    if (runErr) throw new Error(runErr.message);
    const { error: resErr } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: run.id,
      p_cost: 1,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
      p_meta: { e2e: "managed-metering seed" },
    });
    if (resErr) throw new Error(resErr.message);
    const { error: accErr } = await db.rpc("accrue_managed_spend", {
      p_org_id: orgId,
      p_amount_usd: amountUsd,
      p_provider: "anthropic",
      p_model: SEED_MODEL,
      p_input_tokens: 1200,
      p_output_tokens: 240,
      p_input_unit_usd: 0.000001,
      p_output_unit_usd: 0.000005,
      p_markup_pct: PLANS.builder.managedMarkupPct,
      p_call_kind: "judge",
      p_eval_run_id: run.id,
      p_opt_run_id: null,
    });
    if (accErr) throw new Error(accErr.message);
  }

  let _rubricId: string | null = null;
  async function rubricId(): Promise<string> {
    if (_rubricId) return _rubricId;
    const { data } = await db
      .from("rubrics")
      .select("id")
      .eq("org_id", orgId)
      .eq("name", RUBRIC_NAME)
      .single();
    const id = data!.id as string;
    _rubricId = id;
    return id;
  }

  async function newPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState });
    return ctx.newPage();
  }

  async function runEvalFromUi(page: Page) {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_NAME }).click();
    await page.getByRole("button", { name: "Run eval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("#user-input-0").fill("Where does this ticket go?");
    await dialog.locator("#agent-output-0").fill("Queue: billing, P2");
    await dialog.getByRole("button", { name: "Run eval" }).click();
    return dialog;
  }

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;
    email = `managed-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Managed Metering Spec Team" })
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
      stripe_customer_id: `cus_managed_${orgId}`,
      stripe_subscription_id: `sub_managed_${orgId}`,
      status: "active",
      stripe_price_id: process.env.STRIPE_PRICE_BUILDER,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      mirror_event_at: new Date().toISOString(),
      email,
    });
    if (mirrorError) throw new Error(mirrorError.message);

    const { error: rubricError } = await db.from("rubrics").insert({
      org_id: orgId,
      created_by: userId,
      name: RUBRIC_NAME,
      scenario_description: "Managed metering spec scenario",
      expected_outcome: "Routed correctly",
      evaluation_mode: "prompt_response",
      criteria: [{ name: "Routing accuracy", weight: 1, steps: ["Right queue?"] }],
    });
    if (rubricError) throw new Error(rubricError.message);

    // Point grant so the points check never blocks — the only gate under test
    // is the Managed Spend Cap.
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

  test("the Billing page shows the Managed Spend Cap at the plan default", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/billing");
    await expect(page.getByTestId("managed-spend-usage")).toContainText(
      new RegExp(`\\$0\\.00\\s*of your \\$${DEFAULT_CAP}\\.00 monthly cap`)
    );
    await page.context().close();
  });

  test("a Contributor can lower the cap, and seeded usage shows in the usage view", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/billing");

    await page.getByTestId("managed-cap-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Monthly cap/).fill(String(CAP_USD));
    await dialog.getByRole("button", { name: "Save cap" }).click();
    await expect(page.getByTestId("managed-spend-usage")).toContainText(
      new RegExp(`of your \\$${CAP_USD}\\.00 monthly cap`)
    );
    await page.context().close();

    // Seed a partial accrual and confirm the usage view lists it.
    await seedAccrual(0.4);
    const page2 = await newPage(browser);
    await page2.goto("/settings/billing");
    await expect(page2.getByTestId("managed-usage-ledger")).toContainText(SEED_MODEL);
    await expect(page2.getByTestId("managed-spend-usage")).toContainText("$0.40");
    await page2.context().close();
  });

  test("at the cap, a run is refused with the managed-cap message and the Contributor email", async ({
    browser,
  }) => {
    // Bring accrued managed spend to the $1 cap.
    await seedAccrual(0.6); // 0.4 + 0.6 = 1.0 = cap

    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);
    await expect(dialog.getByRole("alert")).toContainText(/managed spend cap/i);
    await page.context().close();

    await expect
      .poll(() => mailpitHasEmail("has reached its managed spend cap", email), {
        timeout: 15_000,
      })
      .toBe(true);
  });
});
