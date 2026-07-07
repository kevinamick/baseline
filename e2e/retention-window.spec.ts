import { test, expect, type Browser, type Page } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { makeAdminClient, mailpitHasEmail } from "./constants";

/**
 * Retention Window — soft-delete, downgrade cliff, re-upgrade restore (#187,
 * ADR-0008). The user-observable journey:
 *   - A Free Team's run older than its 14-day window is gone from the run history.
 *   - A downgrade that shrinks the window (Scale 3y → Builder 90d) bulk-soft-deletes
 *     the now-out-of-window history (gone from the list AND the addressable
 *     deep-link) and emails Contributors.
 *   - Re-upgrading within the 30-day grace restores everything not yet purged.
 *
 * Nothing here hard-deletes — the purge job (≥30 days later) is covered by the
 * integration invariants. The downgrade is driven exactly as Stripe would: a
 * SIGNED customer.subscription.updated rolling the mirror to the new plan, which
 * triggers the webhook's retention hook. Provisions its OWN orgs so billing state
 * can't leak into the shared fixtures; teardown is one org delete (FK cascade).
 */

const PASSWORD = "password123";
const DAY = 86_400_000;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_SCALE = process.env.STRIPE_PRICE_SCALE;
const PRICE_BUILDER = process.env.STRIPE_PRICE_BUILDER;

test.describe.configure({ mode: "serial" });

test.describe("Retention Window — soft-delete, downgrade cliff, restore (#187)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  test.skip(!WEBHOOK_SECRET, "needs STRIPE_WEBHOOK_SECRET to sign webhooks");
  test.skip(!PRICE_SCALE || !PRICE_BUILDER, "needs Stripe price ids for the plan downgrade");

  let db: SupabaseClient;
  const signer = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");

  // --- Scale org (downgrade cliff + restore) ---
  let scaleOrg: string;
  let scaleUser: string;
  let scaleEmail: string;
  let scaleCustomer: string;
  let scaleSub: string;
  let scaleRubric: string;
  let scaleConn: string;
  let agedEval: string;
  let agedOpt: string;
  let scaleState: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>>;

  // --- Free org (steady-state aging) ---
  let freeOrg: string;
  let freeUser: string;
  let freeEmail: string;
  let freeRubric: string;
  let freeState: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>>;

  const periodStart = new Date(Date.now() - 5 * DAY).toISOString();
  const periodEnd = new Date(Date.now() + 25 * DAY).toISOString();

  // Monotonic `created` (seconds) so each status webhook beats the mirror's
  // recency guard and the next event beats the previous one.
  let createdSeq = Math.floor(Date.now() / 1000);
  const nextCreated = () => ++createdSeq;

  async function signIn(browser: Browser, email: string) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    const state = await ctx.storageState();
    await ctx.close();
    return state;
  }

  async function newUser(email: string): Promise<string> {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    return data.user.id;
  }

  async function newRubric(orgId: string, userId: string, name: string): Promise<string> {
    const { data, error } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name,
        scenario_description: "retention spec",
        expected_outcome: "ok",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  async function newEval(orgRubric: string, userId: string, description: string, ageDays: number): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({
        created_by: userId,
        rubric_id: orgRubric,
        status: "completed",
        description,
        overall_score: 0.9,
        created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  // POST a signed customer.subscription.updated rolling the mirror to `priceId`.
  async function postPlanChange(
    request: import("@playwright/test").APIRequestContext,
    priceId: string,
  ) {
    const created = nextCreated();
    const event = {
      id: `evt_${crypto.randomUUID()}`,
      object: "event",
      type: "customer.subscription.updated",
      created,
      data: {
        object: {
          id: scaleSub,
          object: "subscription",
          customer: scaleCustomer,
          status: "active",
          cancel_at_period_end: false,
          metadata: { org_id: scaleOrg },
          current_period_start: Math.floor(Date.parse(periodStart) / 1000),
          current_period_end: Math.floor(Date.parse(periodEnd) / 1000),
          items: {
            data: [
              {
                price: { id: priceId },
                current_period_start: Math.floor(Date.parse(periodStart) / 1000),
                current_period_end: Math.floor(Date.parse(periodEnd) / 1000),
              },
            ],
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET! });
    const res = await request.post("/api/webhooks/stripe", {
      headers: { "stripe-signature": sig, "content-type": "application/json" },
      data: payload,
    });
    expect(res.status()).toBe(200);
  }

  async function newPage(browser: Browser, state: typeof scaleState): Promise<Page> {
    const ctx = await browser.newContext({ storageState: state });
    return ctx.newPage();
  }

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;

    // Scale org with an active Scale subscription mirror.
    scaleEmail = `retention-scale-${crypto.randomUUID().slice(0, 8)}@baseline.test`;
    scaleUser = await newUser(scaleEmail);
    const { data: org1, error: org1Err } = await db
      .from("organizations")
      .insert({ name: "Retention Scale Team" })
      .select("id")
      .single();
    if (org1Err) throw new Error(org1Err.message);
    scaleOrg = org1.id;
    scaleCustomer = `cus_retention_${scaleOrg}`;
    scaleSub = `sub_retention_${scaleOrg}`;
    await db.from("memberships").insert({ org_id: scaleOrg, user_id: scaleUser, role: "admin" });
    const { error: mirrorErr } = await db.from("customers").insert({
      org_id: scaleOrg,
      stripe_customer_id: scaleCustomer,
      stripe_subscription_id: scaleSub,
      status: "active",
      stripe_price_id: PRICE_SCALE,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      // Clearly in the past so the plan-change events win the recency guard.
      mirror_event_at: new Date(Date.now() - DAY).toISOString(),
      email: scaleEmail,
    });
    if (mirrorErr) throw new Error(mirrorErr.message);

    scaleRubric = await newRubric(scaleOrg, scaleUser, "Retention scale rubric");
    const { data: conn, error: connErr } = await db
      .from("connections")
      .insert({
        org_id: scaleOrg,
        created_by: scaleUser,
        name: "Retention agent",
        kind: "agent",
        endpoint: "https://example.test/agent",
        response_path: "output",
      })
      .select("id")
      .single();
    if (connErr) throw new Error(connErr.message);
    scaleConn = conn.id;

    // 120 days old: inside Scale's 3-year window, outside Builder's 90-day window.
    agedEval = await newEval(scaleRubric, scaleUser, "Aged scale eval", 120);
    await newEval(scaleRubric, scaleUser, "Recent scale eval", 1);
    const { data: opt, error: optErr } = await db
      .from("optimization_runs")
      .insert({
        org_id: scaleOrg,
        created_by: scaleUser,
        connection_id: scaleConn,
        rubric_id: scaleRubric,
        budget_rollouts: 10,
        max_iters: 1,
        status: "completed",
        created_at: new Date(Date.now() - 120 * DAY).toISOString(),
      })
      .select("id")
      .single();
    if (optErr) throw new Error(optErr.message);
    agedOpt = opt.id;

    // Free org — no subscription mirror, so it floors to the Free plan (14-day window).
    freeEmail = `retention-free-${crypto.randomUUID().slice(0, 8)}@baseline.test`;
    freeUser = await newUser(freeEmail);
    const { data: org2, error: org2Err } = await db
      .from("organizations")
      .insert({ name: "Retention Free Team" })
      .select("id")
      .single();
    if (org2Err) throw new Error(org2Err.message);
    freeOrg = org2.id;
    await db.from("memberships").insert({ org_id: freeOrg, user_id: freeUser, role: "admin" });
    freeRubric = await newRubric(freeOrg, freeUser, "Retention free rubric");
    await newEval(freeRubric, freeUser, "Aged free eval", 15); // past the 14-day window
    await newEval(freeRubric, freeUser, "Recent free eval", 2); // inside it

    scaleState = await signIn(browser, scaleEmail);
    freeState = await signIn(browser, freeEmail);
  });

  test.afterAll(async () => {
    for (const orgId of [scaleOrg, freeOrg]) {
      if (orgId) await db.from("organizations").delete().eq("id", orgId);
    }
    for (const userId of [scaleUser, freeUser]) {
      if (userId) await db.auth.admin.deleteUser(userId);
    }
  });

  test("a Free Team's run past the 14-day window is gone from history, labelled per plan", async ({
    browser,
  }) => {
    // Steady-state aging: the daily sweep soft-deletes against the Free cutoff.
    // (The sweep route needs RETENTION_SECRET, unset here; drive the same RPC it
    // calls — the route→RPC wiring is covered by the integration tests.)
    const cutoff = new Date(Date.now() - 14 * DAY).toISOString();
    const { error } = await db.rpc("expire_runs_before", { p_org_id: freeOrg, p_cutoff: cutoff });
    if (error) throw new Error(error.message);

    const page = await newPage(browser, freeState);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "Retention free rubric" }).click();

    // The recent run is still shown; the aged-out run is gone.
    await expect(page.getByText("Recent free eval")).toBeVisible();
    await expect(page.getByText("Aged free eval")).toHaveCount(0);
    // The boundary is labelled with the Free plan's window.
    await expect(page.getByText(/last 14 days/)).toBeVisible();
    await expect(page.getByText(/retention window/)).toBeVisible();
    await page.context().close();
  });

  test("downgrading Scale → Builder soft-deletes out-of-window history and emails Contributors", async ({
    browser,
    request,
  }) => {
    // Visible while on Scale (3-year window), labelled accordingly.
    const before = await newPage(browser, scaleState);
    await before.goto("/rubrics");
    await before.getByRole("button", { name: "Retention scale rubric" }).click();
    await expect(before.getByText("Aged scale eval")).toBeVisible();
    await expect(before.getByText(/last 3 years/)).toBeVisible();
    await before.context().close();

    // The downgrade executes: Stripe rolls the subscription to the Builder price.
    await postPlanChange(request, PRICE_BUILDER!);

    // The mirror now reflects Builder, and the out-of-window runs are soft-deleted.
    await expect
      .poll(async () => {
        const { data } = await db.from("eval_runs").select("deleted_at").eq("id", agedEval).single();
        return data?.deleted_at as string | null;
      }, { timeout: 15_000 })
      .not.toBeNull();

    // Contributors are emailed the loud downgrade-cliff notice.
    await expect
      .poll(() => mailpitHasEmail("moved out of your retention window", scaleEmail), { timeout: 15_000 })
      .toBe(true);

    // Gone from the run history list — only the recent run survives, now labelled 90 days.
    const page = await newPage(browser, scaleState);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "Retention scale rubric" }).click();
    await expect(page.getByText("Recent scale eval")).toBeVisible();
    await expect(page.getByText("Aged scale eval")).toHaveCount(0);
    await expect(page.getByText(/last 90 days/)).toBeVisible();
    await page.context().close();

    // Gone from the addressable deep-link too (not just the list).
    const direct = await newPage(browser, scaleState);
    await direct.goto(`/optimizations?run=${agedOpt}`);
    await expect(direct.getByText("No optimization runs yet.")).toBeVisible();
    await direct.context().close();
  });

  test("re-upgrading Builder → Scale within grace restores the hidden history", async ({
    browser,
    request,
  }) => {
    await postPlanChange(request, PRICE_SCALE!);

    // The soft-delete flag is cleared (run back inside the 3-year window).
    await expect
      .poll(async () => {
        const { data } = await db.from("eval_runs").select("deleted_at").eq("id", agedEval).single();
        return data?.deleted_at as string | null;
      }, { timeout: 15_000 })
      .toBeNull();

    const page = await newPage(browser, scaleState);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "Retention scale rubric" }).click();
    await expect(page.getByText("Aged scale eval")).toBeVisible();
    await expect(page.getByText(/last 3 years/)).toBeVisible();
    await page.context().close();

    // The optimization run is addressable again.
    const opt = await newPage(browser, scaleState);
    await opt.goto(`/optimizations?run=${agedOpt}`);
    await expect(opt.getByText("Retention agent").first()).toBeVisible();
    await opt.context().close();
  });
});
