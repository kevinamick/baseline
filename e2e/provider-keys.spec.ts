import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeAdminClient } from "./constants";
import { anniversaryPeriod } from "../src/lib/billing/period";
import { PLANS } from "../src/lib/billing/plans";

/**
 * BYO Keys (#184): a Free Team runs on its own LLM provider key — there is no
 * managed fallback. This spec drives the Free invariant end-to-end through the
 * UI: a keyless Free Team is blocked from running (inline refusal), a
 * Contributor adds a key in the Team settings Provider keys section (masked,
 * write-only — the value never appears in any response body), and removing it
 * restores the block.
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

  test("a keyless Free Team is blocked from running with an inline refusal", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    const dialog = await runEvalFromUi(page);

    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText(/provider key/i);
    await expect(alert).toContainText(/Team/i);
    await page.context().close();
  });

  test("the Team settings page hosts the Provider keys section with every provider runtime-ready (#204)", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/team");

    await expect(page.getByRole("heading", { name: "Provider keys" })).toBeVisible();
    await expect(page.getByText("Anthropic", { exact: true })).toBeVisible();
    // OpenAI and Google are runtime-wired now (#204) — no "Coming soon" badge on any provider row.
    await expect(page.locator("li", { hasText: "OpenAI" })).toBeVisible();
    await expect(page.locator("li", { hasText: "Google" })).toBeVisible();
    await expect(page.getByText("Coming soon")).toHaveCount(0);
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

    await page.goto("/settings/team");
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
    await page.goto("/settings/team");

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

// Non-Anthropic runtime provider (#204): OpenAI and Google are runtime-wired now — the settings page
// shows a stored OpenAI key as set with no "Coming soon" badge. EVAL runs are provider-aware for BYO
// keys (worker.ts's resolveEvalJudge judges on whatever runtime-ready provider the Team brought, at
// the Team's own cost), so a Free Team holding only an OpenAI key can run an eval on that key — the
// Anthropic pin applies only to the managed path (paid Teams with no BYO key). This block provisions
// its own Free org and stores an OpenAI BYO key directly (the gate checks key PRESENCE for a
// runtime-ready provider, not validity).
test.describe("BYO Keys — non-Anthropic provider (#204)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  const RUBRIC = "OpenAI provider key spec rubric";
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;
    const email = `openai-key-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    // No customers mirror row → Free (BYO required, no managed fallback).
    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "OpenAI Provider Key Spec Team" })
      .select("id, created_at")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    const { error: rubricError } = await db.from("rubrics").insert({
      org_id: orgId,
      created_by: userId,
      name: RUBRIC,
      scenario_description: "OpenAI provider key spec scenario",
      expected_outcome: "Routed correctly",
      evaluation_mode: "prompt_response",
      criteria: [{ name: "Routing accuracy", weight: 1, steps: ["Right queue?"] }],
    });
    if (rubricError) throw new Error(rubricError.message);

    // The Team's only key is an OpenAI BYO key — no Anthropic key at all.
    const { error: keyError } = await db.rpc("set_provider_key", {
      p_org_id: orgId,
      p_provider: "openai",
      p_secret: "sk-openai-e2e-204-key",
      p_last4: "0key",
      p_created_by: userId,
    });
    if (keyError) throw new Error(keyError.message);

    // Seed the Free period's point grant so a keyed run clears the points check too.
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

  test("the OpenAI key shows as set with no 'Coming soon' badge", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState });
    const page = await ctx.newPage();
    await page.goto("/settings/team");
    const openaiRow = page.locator("li", { hasText: "OpenAI" });
    await expect(openaiRow.getByText("Key set", { exact: false })).toBeVisible();
    await expect(openaiRow.getByText("Coming soon")).toHaveCount(0);
    await ctx.close();
  });

  test("a Free Team with only an OpenAI key can run an eval (judge is provider-aware) (#204)", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState });
    const page = await ctx.newPage();
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC }).click();
    await page.getByRole("button", { name: "Run eval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("#user-input-0").fill("Where does this ticket go?");
    await dialog.locator("#agent-output-0").fill("Queue: billing, P2");
    await dialog.getByRole("button", { name: "Run eval" }).click();
    // Accepted — the eval judge is provider-aware, so an OpenAI-only Free Team clears the
    // provider-key gate and the run is created (the dialog closes) on its own OpenAI key, rather
    // than being refused. The worker judges on that key; the e2e stack runs no worker, so the
    // assertion is just the app-side accept (dialog hidden, no provider-key refusal).
    await expect(dialog).toBeHidden();
    await ctx.close();
  });
});

// Optimization run on a non-Anthropic key (#204 acceptance): the run a non-Anthropic key actually
// drives is the OPTIMIZATION run — its judge + reflection follow the chosen reflect model's provider,
// so a Team picking an OpenAI reflect model runs the whole optimization on its OpenAI key (eval runs,
// by contrast, are Anthropic-only — see the describe above). This provisions its own paid (Builder)
// org whose ONLY LLM key is OpenAI, drives the provider-grouped wizard to "Start run" selecting GPT-5
// as the reflect model, and asserts the run clears every provider/key/billing gate on that OpenAI
// key. The e2e stack runs no Temporal worker (the same constraint optimization-wizard.spec.ts
// documents), so the start stops at the worker-dispatch boundary — never a provider-key refusal.
test.describe("BYO Keys — non-Anthropic optimization run (#204)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  const RUBRIC = "OpenAI optimization spec rubric";
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;
    const email = `openai-opt-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    // Builder subscription via a seeded Stripe mirror row → paid (the optimization wizard is gated
    // to paid Teams, #181). The run still resolves the Team's own OpenAI key, not the managed key.
    const periodStart = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const periodEnd = new Date(Date.now() + 25 * 86_400_000).toISOString();
    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "OpenAI Optimization Spec Team" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    const { error: mirrorError } = await db.from("customers").insert({
      org_id: orgId,
      stripe_customer_id: `cus_openai_opt_${orgId}`,
      stripe_subscription_id: `sub_openai_opt_${orgId}`,
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
      name: RUBRIC,
      scenario_description: "OpenAI optimization spec scenario",
      expected_outcome: "Routed correctly",
      evaluation_mode: "prompt_response",
      criteria: [{ name: "Routing accuracy", weight: 1, steps: ["Right queue?"] }],
    });
    if (rubricError) throw new Error(rubricError.message);

    // The Team's only LLM key is OpenAI — no Anthropic key at all. The run's judge + reflection
    // resolve THIS key because the reflect model selected in the wizard is an OpenAI model.
    const { error: keyError } = await db.rpc("set_provider_key", {
      p_org_id: orgId,
      p_provider: "openai",
      p_secret: "sk-openai-e2e-204-opt-key",
      p_last4: "opt0",
      p_created_by: userId,
    });
    if (keyError) throw new Error(keyError.message);

    // Grant the Builder optimization allowance so the run clears the allowance gate (#181).
    const { error: grantError } = await db.rpc("ensure_optimization_grant", {
      p_org_id: orgId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: PLANS.builder.includedOptimizationRuns,
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

  test("the OpenAI key drives an optimization run through the provider-aware wizard", async ({
    browser,
  }) => {
    // Starting the run reaches the Temporal dispatch, which has no server in the e2e stack; the
    // client waits out its connect timeout (~10s) before the action settles, so give the test room.
    test.setTimeout(90_000);
    const ctx = await browser.newContext({ storageState });
    const page = await ctx.newPage();
    await page.goto("/optimizations");
    await page.getByRole("button", { name: "+ New run" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New optimization run" })).toBeVisible();

    // Basics — the seeded rubric.
    await dialog.getByLabel("Rubric").selectOption({ label: RUBRIC });
    await dialog.getByRole("button", { name: "Next" }).click();

    // System — managed "Paste a prompt" mode (#293) needs just a prompt. Switch to Reflective so the
    // Tuning step exposes a "Reflection model" select; the managed default is Simple (no reflect model).
    await dialog.locator("#opt-managed-prompt").fill("Route the ticket to the right queue.");
    await dialog.getByRole("radio", { name: /Reflective/ }).check();
    await dialog.getByRole("button", { name: "Next" }).click();

    // Instances — one input row.
    await dialog.getByPlaceholder(/User input/).fill("Where does this ticket go?");
    await dialog.getByRole("button", { name: "Next" }).click();

    // Tuning — reveal the advanced section and pick an OpenAI reflect model, so the run's judge +
    // reflection run on the Team's OpenAI key. The dropdown only offers usable providers (#204).
    await dialog.getByRole("button", { name: "Advanced settings" }).click();
    await dialog.getByLabel("Reflection model").selectOption({ label: "GPT-5 — most capable" });
    await dialog.getByRole("button", { name: "Next" }).click();

    // Review names the OpenAI reflect model the run will use — proof the non-Anthropic key drives it.
    await expect(dialog.getByText("GPT-5 — most capable")).toBeVisible();
    await dialog.getByRole("button", { name: "Start run" }).click();

    // The OpenAI key clears every provider/key/billing gate: the only thing left is the Temporal
    // worker, which the e2e stack doesn't run, so the start stops at the dispatch boundary. Crucially
    // this is NOT a provider-key refusal (the eval-run block above) — the non-Anthropic key is
    // accepted for the optimization run.
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText(/Failed to start optimization run/i, { timeout: 30_000 });
    await expect(alert).not.toContainText(/provider key/i);
    await ctx.close();
  });
});

// Onboarding (#334): creating a Team sends the user straight into the app, and
// /onboarding is strictly the "no Team yet" route — an existing-Team user who
// navigates back is redirected to /rubrics. The Free provider-key prompt no
// longer lives here; it moved into the /rubrics guided tutorial (#333).
// Provisions its own no-org user; the Team is created through the UI, so
// teardown deletes whatever org it joined.
test.describe("BYO Keys — onboarding (#334)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let userId: string;
  let email: string;

  test.beforeAll(async () => {
    db = makeAdminClient()!;
    email = `onboard-${crypto.randomUUID().slice(0, 8)}@baseline.test`;
    const { data: authUser, error } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    userId = authUser.user.id;
  });

  test.afterAll(async () => {
    const { data: rows } = await db.from("memberships").select("org_id").eq("user_id", userId);
    for (const row of rows ?? []) await db.from("organizations").delete().eq("id", row.org_id);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  test("creating a Team lands straight in the app, and /onboarding then redirects away", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 90_000 });

    await page.goto("/onboarding");
    await page.getByLabel("Team name").fill("Onboarding Spec Team");
    await page.getByRole("button", { name: "Create team" }).click();

    // #334: creating the Team sends the user straight into the app — no
    // interstitial provider-key step. The Free key prompt now lives in the
    // /rubrics guided tutorial.
    await expect(page).toHaveURL(/\/rubrics/, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "Add a provider key" })
    ).toHaveCount(0);

    // The back-navigation guard: with a Team now, /onboarding redirects out.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/rubrics/, { timeout: 30_000 });
    await ctx.close();
  });
});
