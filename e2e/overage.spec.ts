import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeAdminClient, mailpitHasEmail } from "./constants";
import { evalRunPointsPerRow } from "../src/lib/billing/points";
import { PLANS } from "../src/lib/billing/plans";

/**
 * Opt-in Overage Caps (#183): a paid Team opts in via the Billing page, burns
 * past its included points, and keeps running — up to the cap, where the wall
 * and the Contributor email take over. The Stripe invoice-item push is
 * unit/integration-tested (the e2e stack runs placeholder Stripe keys); the
 * e2e asserts the in-app overage view the push derives from.
 *
 * The spec provisions its OWN org, user, and Builder mirror row: the shared
 * cap prices BOTH meters, so the seeded paid fixture (Team C) would leak the
 * optimization-allowance spec's parallel ledger churn into these assertions.
 * Teardown is one org delete — the FK cascade clears the ledgers, which the
 * append-only grants would otherwise forbid.
 *
 * Serial: the tests walk the Team through opt-in → overage → warning →
 * wall → opt-out.
 */

const PASSWORD = "password123";
const INCLUDED = PLANS.builder.includedEvalPoints;
const POINT_USD = PLANS.builder.evalPointOverageUsd!;
const CAP_USD = 5;
const CAP_POINTS = CAP_USD / POINT_USD; // 10,000 at $0.0005
/** What the burn-down leaves: below any single row's cost (min is 10 + 5×1). */
const LEAVE = 5;
const RUBRIC_NAME = "Overage spec rubric";

test.describe.configure({ mode: "serial" });

test.describe("Overage Caps (#183)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let email: string;
  let periodStart: string;
  let periodEnd: string;
  let runCost: number;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  async function pointBalance(): Promise<number> {
    const { data } = await db.rpc("point_balance", {
      p_org_id: orgId,
      p_period_start: periodStart,
    });
    return Number(data ?? 0);
  }

  // The same RPC the app uses; the cap (when one is set via the UI) is read
  // by the SQL itself from billing_settings.
  async function burn(cost: number) {
    const { data, error } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: null,
      p_cost: cost,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
      p_meta: { e2e: "overage-spec burn" },
      p_point_unit_usd: POINT_USD,
    });
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row?.reserved).toBe(true);
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
    email = `overage-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Overage Spec Team" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    // Builder subscription via a seeded mirror row, exactly like Team C.
    periodStart = new Date(Date.now() - 5 * 86_400_000).toISOString();
    periodEnd = new Date(Date.now() + 25 * 86_400_000).toISOString();
    const { error: mirrorError } = await db.from("customers").insert({
      org_id: orgId,
      stripe_customer_id: `cus_overage_${orgId}`,
      stripe_subscription_id: `sub_overage_${orgId}`,
      status: "active",
      stripe_price_id: process.env.STRIPE_PRICE_BUILDER,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      mirror_event_at: new Date().toISOString(),
      email,
    });
    if (mirrorError) throw new Error(mirrorError.message);

    const criteria = [
      { name: "Routing accuracy", weight: 0.7, steps: ["Right queue?"] },
      { name: "Priority fit", weight: 0.3, steps: ["Priority justified?"] },
    ];
    const { error: rubricError } = await db.from("rubrics").insert({
      org_id: orgId,
      created_by: userId,
      name: RUBRIC_NAME,
      scenario_description: "Overage spec scenario",
      expected_outcome: "Routed correctly",
      evaluation_mode: "prompt_response",
      criteria,
    });
    if (rubricError) throw new Error(rubricError.message);
    runCost = evalRunPointsPerRow(criteria.length);

    const { error: grantError } = await db.rpc("ensure_point_grant", {
      p_org_id: orgId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
    });
    if (grantError) throw new Error(grantError.message);

    // Burn the included allotment down to LEAVE so every UI run is overage.
    await burn(INCLUDED - LEAVE);

    // Sign the spec's user in once; every test reuses the captured state.
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
    // The org delete cascades memberships, rubric, runs, the mirror row, the
    // ledgers, settings, and invoice lines in one stroke.
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  test("opting in IS setting a cap — the dialog takes an amount, the card shows it", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/billing");

    // Off by default, stated plainly.
    await expect(page.getByTestId("overage-off")).toContainText("Off");
    // Exhausted (LEAVE < cheapest run) and no cap → the hard-stop line shows.
    await expect(page.getByTestId("points-exhausted")).toBeVisible();

    await page.getByTestId("overage-cap-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Monthly cap/).fill(String(CAP_USD));
    await dialog.getByRole("button", { name: "Save cap" }).click();

    await expect(page.getByTestId("overage-usage")).toContainText(
      new RegExp(`\\$0\\.00\\s*of your \\$${CAP_USD}\\.00 monthly cap`)
    );
    // With cap headroom the exhausted warning would be a lie — it's gone.
    await expect(page.getByTestId("points-exhausted")).toHaveCount(0);
    await page.context().close();
  });

  test("a run past included proceeds into overage and the page shows the committed amount", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);
    await expect(dialog).toBeHidden(); // accepted — no refusal alert

    const over = runCost - LEAVE;
    await page.goto("/settings/billing");
    await expect(page.getByTestId("overage-breakdown")).toContainText(
      `${over.toLocaleString("en-US")} Eval Points over included`
    );
    await expect(page.getByTestId("point-balance")).toHaveText(
      new RegExp(`^0\\s*of ${INCLUDED.toLocaleString("en-US")} remaining$`)
    );
    await page.context().close();
  });

  test("crossing 80% of the cap emails the Contributors a warning", async ({
    browser,
  }) => {
    // Bring committed overage to ~88% via the same RPC the app uses, then a
    // real UI run crosses the app-side warning check.
    const committedOver = -(await pointBalance());
    await burn(Math.floor(CAP_POINTS * 0.88) - committedOver);

    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);
    await expect(dialog).toBeHidden();
    await page.context().close();

    await expect
      .poll(() => mailpitHasEmail("is approaching its overage cap", email), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("at the cap the run is blocked with the cap message and the limit email", async ({
    browser,
  }) => {
    // Commit the rest of the headroom exactly.
    await burn(CAP_POINTS - -(await pointBalance()));

    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText(`past its $${CAP_USD} monthly overage cap`);
    await page.context().close();

    await expect
      .poll(() => mailpitHasEmail("has reached its overage cap", email), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("turning overage off restores the hard stop for new work", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/billing");
    await page.getByTestId("overage-off-button").click();
    await page.getByRole("button", { name: "Turn off" }).last().click();

    await expect(page.getByTestId("overage-off")).toContainText("Off");
    // No cap, balance below the cheapest run → the hard-stop line is honest again.
    await expect(page.getByTestId("points-exhausted")).toBeVisible();

    // And a new run is refused with the classic points message.
    const dialog = await runEvalFromUi(page);
    await expect(dialog.getByRole("alert")).toContainText("Not enough Eval Points");
    await page.context().close();
  });
});