import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeAdminClient, mailpitHasEmail } from "./constants";
import { anniversaryPeriod } from "../src/lib/billing/period";
import { PLANS } from "../src/lib/billing/plans";

/**
 * BYO Keys (#184): a Free Team runs on its own LLM provider key — there is no
 * managed fallback. This spec drives the Free invariant end-to-end through the
 * UI: a keyless Free Team is blocked from running (with the Contributor email),
 * a Contributor adds a key on the API Keys page (masked, write-only — the value
 * never appears in any response body), and removing it restores the block.
 *
 * The spec provisions its OWN Free org/user (no customers mirror = Free) so the
 * gate fires; teardown is one org delete (FK cascade clears the key row, which
 * purges its Vault secret via the trigger).
 *
 * The BYO key stored here is a dummy — the e2e stack doesn't score runs against a
 * live provider, and the gate checks a key's PRESENCE, not its validity. So the
 * assertions are the deterministic, app-side ones: blocked-vs-accepted at run
 * creation, the email, and the masked write-only display.
 */

const PASSWORD = "password123";
const RUBRIC_NAME = "Provider key spec rubric";
// Dummy BYO key — its last4 drives the masked-display assertion; its full value
// must never surface in any response body.
const BYO_KEY = "sk-ant-e2e-provider-key-9911";
const KEY_LAST4 = "9911";

test.describe.configure({ mode: "serial" });

test.describe("BYO Keys (#184)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let email: string;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  async function newPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState });
    return ctx.newPage();
  }

  // Open the run dialog and submit one row. Returns the dialog locator so the
  // caller can assert acceptance (hidden) or refusal (its alert).
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
    email = `provider-key-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    // No customers mirror row → the Team is Free (BYO required).
    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Provider Key Spec Team" })
      .select("id, created_at")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    const { error: rubricError } = await db.from("rubrics").insert({
      org_id: orgId,
      created_by: userId,
      name: RUBRIC_NAME,
      scenario_description: "Provider key spec scenario",
      expected_outcome: "Routed correctly",
      evaluation_mode: "prompt_response",
      criteria: [{ name: "Routing accuracy", weight: 1, steps: ["Right queue?"] }],
    });
    if (rubricError) throw new Error(rubricError.message);

    // Seed the Free period's point grant (same period the app resolves) so a
    // keyed run clears the points check and the only gate in play is the key.
    const { start, end } = anniversaryPeriod(new Date(org.created_at), new Date());
    const { error: grantError } = await db.rpc("ensure_point_grant", {
      p_org_id: orgId,
      p_period_start: start.toISOString(),
      p_period_end: end.toISOString(),
      p_included: PLANS.free.includedEvalPoints,
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

  test("a keyless Free Team is blocked from running, and Contributors are emailed", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);

    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText(/provider key/i);
    await expect(alert).toContainText(/API Keys/i);
    await page.context().close();

    await expect
      .poll(() => mailpitHasEmail("needs a provider key", email), { timeout: 15_000 })
      .toBe(true);
  });

  test("the API Keys page shows providers, with non-runtime ones marked coming soon", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/api-keys");

    await expect(page.getByText("Anthropic", { exact: true })).toBeVisible();
    // OpenAI and Google store keys but aren't runtime-wired yet.
    const openaiRow = page.locator("li", { hasText: "OpenAI" });
    await expect(openaiRow.getByText("Coming soon")).toBeVisible();
    await page.context().close();
  });

  test("adding a key is write-only — masked display, value never in any response", async ({
    browser,
  }) => {
    const page = await newPage(browser);

    // Capture every same-origin response body during the save flow; the raw key
    // must never appear in any of them.
    const bodies: string[] = [];
    page.on("response", async (res) => {
      try {
        if (new URL(res.url()).origin === new URL(page.url() || "http://x").origin) {
          bodies.push(await res.text());
        }
      } catch {
        /* opaque/streamed responses — nothing to inspect */
      }
    });

    await page.goto("/settings/api-keys");
    const anthropicRow = page.locator("li", { hasText: "Anthropic" });
    await anthropicRow.getByRole("button", { name: "Add key" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.locator("#provider-key-input").fill(BYO_KEY);
    await dialog.getByRole("button", { name: "Save key" }).click();

    // The row now shows the masked tail (•••• 9911), never the key. Match on the
    // last4 by regex — the bullets are joined by a non-breaking space.
    await expect(anthropicRow.getByText("Key set", { exact: false })).toBeVisible();
    await expect(anthropicRow.getByText(new RegExp(KEY_LAST4))).toBeVisible();
    await expect(page.getByText(BYO_KEY)).toHaveCount(0);

    // Give any trailing responses a beat, then assert the raw key never leaked.
    await page.waitForTimeout(250);
    expect(bodies.some((b) => b.includes(BYO_KEY))).toBe(false);

    await page.context().close();
  });

  test("with a key set, the Free Team's run is accepted", async ({ browser }) => {
    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);
    // Accepted — the dialog closes with no provider-key refusal.
    await expect(dialog).toBeHidden();
    await page.context().close();
  });

  test("removing the key restores the hard block", async ({ browser }) => {
    const page = await newPage(browser);
    await page.goto("/settings/api-keys");

    const anthropicRow = page.locator("li", { hasText: "Anthropic" });
    await anthropicRow.getByRole("button", { name: "Remove" }).click();
    // The destructive confirm (Esc-proof) — confirm explicitly.
    await page.getByRole("button", { name: "Remove key" }).click();
    await expect(anthropicRow.getByText("No key set")).toBeVisible();
    await page.context().close();

    const page2 = await newPage(browser);
    const dialog = await runEvalFromUi(page2);
    await expect(dialog.getByRole("alert")).toContainText(/provider key/i);
    await page2.context().close();
  });
});
