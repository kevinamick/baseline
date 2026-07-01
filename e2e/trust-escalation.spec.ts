import { test, expect, type Browser, type Page } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { makeAdminClient } from "./constants";

/**
 * Trust escalation for the Managed Spend Cap (#188, ADR-0008). The user-observable
 * journey on the billing page:
 *   - A brand-new paid Team's cap ceiling is the plan default; a raise above it is
 *     refused server-side with legible copy (the ceiling grows with paid invoices).
 *   - After (simulated) paid invoices land via signed Stripe webhooks, the ceiling
 *     visibly increases, and a raise up to the new ceiling now succeeds.
 *
 * Paid invoices are driven exactly as Stripe would: SIGNED invoice.paid events,
 * which the webhook feeds into the paid_invoices trust mirror. Provisions its own
 * Builder Team so trust history can't leak into shared fixtures; teardown is one
 * org delete (FK cascade) + the auth user.
 */

const PASSWORD = "password123";
const DAY = 86_400_000;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_BUILDER = process.env.STRIPE_PRICE_BUILDER;

test.describe.configure({ mode: "serial" });

test.describe("Trust escalation — cap ceiling grows with paid invoices (#188)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  test.skip(!WEBHOOK_SECRET, "needs STRIPE_WEBHOOK_SECRET to sign webhooks");
  test.skip(!PRICE_BUILDER, "needs STRIPE_PRICE_BUILDER for an active paid Team");

  let db: SupabaseClient;
  const signer = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");

  let orgId: string;
  let userId: string;
  let email: string;
  let customerId: string;
  let state: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>>;

  const periodStart = new Date(Date.now() - 5 * DAY).toISOString();
  const periodEnd = new Date(Date.now() + 25 * DAY).toISOString();

  async function signIn(browser: Browser): Promise<typeof state> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    const s = await ctx.storageState();
    await ctx.close();
    return s;
  }

  async function newPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: state });
    return ctx.newPage();
  }

  // POST a signed invoice.paid so the webhook records a paid invoice for the Team.
  async function postPaidInvoice(
    request: import("@playwright/test").APIRequestContext,
  ) {
    const id = crypto.randomUUID();
    const event = {
      id: `evt_${id}`,
      object: "event",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `in_${id}`,
          object: "invoice",
          customer: customerId,
          amount_paid: 4900,
          payments: { data: [{ payment: { payment_intent: `pi_${id}` } }] },
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

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;
    email = `trust-${crypto.randomUUID().slice(0, 8)}@baseline.test`;
    const { data: authUser, error: userErr } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (userErr) throw new Error(userErr.message);
    userId = authUser.user.id;

    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({ name: "Trust Escalation Team" })
      .select("id")
      .single();
    if (orgErr) throw new Error(orgErr.message);
    orgId = org.id;
    customerId = `cus_trust_${orgId}`;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    // Active Builder mirror: managed spend applies, default cap $25.
    const { error: mirrorErr } = await db.from("customers").insert({
      org_id: orgId,
      stripe_customer_id: customerId,
      stripe_subscription_id: `sub_trust_${orgId}`,
      status: "active",
      stripe_price_id: PRICE_BUILDER,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      email,
    });
    if (mirrorErr) throw new Error(mirrorErr.message);

    state = await signIn(browser);
  });

  test.afterAll(async () => {
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  test("a new Team's ceiling is the plan default and a higher raise is refused", async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.goto("/settings/billing");

    // 0 paid invoices → ceiling = Builder default $25.
    await expect(page.getByTestId("trust-ceiling")).toContainText("$25.00");

    // Raising above the ceiling is refused server-side with legible copy.
    await page.getByTestId("managed-cap-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Monthly cap (USD)").fill("60");
    await dialog.getByRole("button", { name: "Save cap" }).click();
    await expect(dialog.getByRole("alert")).toContainText(/ceiling/i);

    await page.context().close();
  });

  test("paying invoices raises the ceiling, and a raise up to it now succeeds", async ({
    browser,
    request,
  }) => {
    // Two paid invoices land (Stripe-signed) → count 2 → Builder ×2 = $50.
    await postPaidInvoice(request);
    await postPaidInvoice(request);
    await expect
      .poll(async () => {
        const { count } = await db
          .from("paid_invoices")
          .select("stripe_invoice_id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .is("reversed_at", null);
        return count ?? 0;
      }, { timeout: 15_000 })
      .toBe(2);

    const page = await newPage(browser);
    await page.goto("/settings/billing");

    // The ceiling visibly increased.
    await expect(page.getByTestId("trust-ceiling")).toContainText("$50.00");

    // A raise up to the new ceiling now succeeds.
    await page.getByTestId("managed-cap-button").click();
    await page.getByLabel("Monthly cap (USD)").fill("50");
    await page.getByRole("button", { name: "Save cap" }).click();
    await expect(page.getByTestId("managed-spend-usage")).toContainText("$50.00");
    await expect(page.getByText("Custom cap set.")).toBeVisible();

    await page.context().close();
  });
});
