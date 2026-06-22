import { test, expect, type Browser, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { makeAdminClient, mailpitHasEmail } from "./constants";
import { PLANS } from "../src/lib/billing/plans";

/**
 * Token invoice line & threshold billing — the credit-risk journey (#186,
 * ADR-0008 Meter 2). When a threshold-billing invoice for accrued managed token
 * spend is DECLINED, managed runs fail closed (Contributor emailed), while the
 * subscription and BYO-key runs keep working; paying the invoice restores managed
 * runs automatically.
 *
 * The e2e stack can't take a real card to a real Stripe decline-and-deliver
 * round-trip against localhost, so — exactly like billing.spec.ts — we drive the
 * webhook the way Stripe would: a SIGNED invoice.payment_failed / invoice.paid
 * carrying the managed-token metadata our invoice issuer sets. The Stripe invoice
 * CREATION itself (create + finalize + watermark) is covered by the integration
 * test; this spec asserts the user-observable state machine: refusal, email,
 * BYO-unaffected, recovery.
 *
 * Provisions its OWN Builder org so its billing state can't leak into the shared
 * fixtures. Teardown is one org delete (FK cascade clears the ledgers).
 */

const PASSWORD = "password123";
const INCLUDED = PLANS.builder.includedEvalPoints;
const SEED_MODEL = "claude-haiku-4-5-20251001";
const RUBRIC_NAME = "Managed threshold spec rubric";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

test.describe.configure({ mode: "serial" });

test.describe("Managed threshold billing — declined card & recovery (#186)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  test.skip(!WEBHOOK_SECRET, "needs STRIPE_WEBHOOK_SECRET to sign webhooks");

  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let email: string;
  let customerId: string;
  let periodStart: string;
  let periodEnd: string;
  let storageState: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>>;
  const signer = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");

  let _rubricId: string | null = null;
  async function rubricId(): Promise<string> {
    if (_rubricId) return _rubricId;
    const { data } = await db
      .from("rubrics")
      .select("id")
      .eq("org_id", orgId)
      .eq("name", RUBRIC_NAME)
      .single();
    _rubricId = data!.id as string;
    return _rubricId;
  }

  // Seed one managed accrual the way the worker does (a run with a point
  // reservation, then accrue) — gives the period realistic un-invoiced spend.
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
      p_meta: { e2e: "managed-threshold seed" },
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

  // The single managed-token invoice declined then paid — recovery clears the
  // block only for the SAME invoice id that set it (mirrors a real card retry).
  const MANAGED_INVOICE_ID = `in_managed_${crypto.randomUUID().slice(0, 12)}`;
  // The PaymentIntent that settled it. Carried inline on the event so the trust
  // mirror's invoice→PI capture (applyTrustWebhook → invoicePaymentIntentId) reads
  // it from the payload instead of falling back to a live `stripe.invoices.retrieve`
  // — that re-fetch hits real Stripe, which 401s in the e2e stack (no real key) and
  // turns an otherwise-hermetic test into a network call that flakes and logs errors.
  const MANAGED_PI_ID = `pi_managed_${crypto.randomUUID().slice(0, 12)}`;

  // POST a signed managed-token invoice event, as Stripe would after finalize.
  async function postManagedInvoiceEvent(
    request: import("@playwright/test").APIRequestContext,
    type: "invoice.payment_failed" | "invoice.paid",
    amountUsd: number
  ) {
    const event = {
      id: `evt_${crypto.randomUUID()}`,
      object: "event",
      type,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: MANAGED_INVOICE_ID,
          object: "invoice",
          customer: customerId,
          amount_due: Math.round(amountUsd * 100),
          amount_paid: type === "invoice.paid" ? Math.round(amountUsd * 100) : 0,
          metadata: { kind: "managed_tokens", org_id: orgId, period_start: periodStart },
          // Inline the settling PaymentIntent (expanded shape) so the trust mirror
          // captures it from the payload and never re-fetches the invoice from Stripe.
          payments: { data: [{ payment: { payment_intent: MANAGED_PI_ID } }] },
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

  async function newPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState });
    return ctx.newPage();
  }

  async function submitEvalRun(page: Page) {
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

  async function managedFailedAt(): Promise<string | null> {
    const { data } = await db
      .from("customers")
      .select("managed_payment_failed_at")
      .eq("org_id", orgId)
      .single();
    return (data?.managed_payment_failed_at as string | null) ?? null;
  }

  test.beforeAll(async ({ browser }) => {
    db = makeAdminClient()!;
    email = `threshold-${crypto.randomUUID().slice(0, 8)}@baseline.test`;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Managed Threshold Spec Team" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;
    customerId = `cus_threshold_${orgId}`;
    await db.from("memberships").insert({ org_id: orgId, user_id: userId, role: "admin" });

    periodStart = new Date(Date.now() - 5 * 86_400_000).toISOString();
    periodEnd = new Date(Date.now() + 25 * 86_400_000).toISOString();
    const { error: mirrorError } = await db.from("customers").insert({
      org_id: orgId,
      stripe_customer_id: customerId,
      stripe_subscription_id: `sub_threshold_${orgId}`,
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
      scenario_description: "Managed threshold spec scenario",
      expected_outcome: "Routed correctly",
      evaluation_mode: "prompt_response",
      criteria: [{ name: "Routing accuracy", weight: 1, steps: ["Right queue?"] }],
    });
    if (rubricError) throw new Error(rubricError.message);

    // Point grant so the points check never blocks — the gate under test is the
    // managed-payment fail-closed gate.
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

  test("a declined managed-token invoice pauses managed runs and emails Contributors", async ({
    browser,
    request,
  }) => {
    await seedAccrual(8); // realistic un-invoiced managed spend on the period

    // The card declined on the threshold invoice — Stripe fires payment_failed.
    await postManagedInvoiceEvent(request, "invoice.payment_failed", 8);

    // Fail-closed flag is set on the mirror (BYO + subscription untouched).
    expect(await managedFailedAt()).not.toBeNull();

    // A managed run is now refused inline with the managed-paused message.
    const page = await newPage(browser);
    const dialog = await submitEvalRun(page);
    await expect(dialog.getByRole("alert")).toContainText(/managed runs are paused/i);
    await page.context().close();

    // Contributors are emailed that managed runs are paused.
    await expect
      .poll(() => mailpitHasEmail("managed token payment failed", email), { timeout: 15_000 })
      .toBe(true);
  });

  test("BYO-key runs keep working while managed payments are failing", async ({ browser }) => {
    // Bring your own provider key → that run spends the customer's tokens and is
    // never gated by managed-payment state.
    const { error } = await db.rpc("set_provider_key", {
      p_org_id: orgId,
      p_provider: "anthropic",
      p_secret: "sk-ant-threshold-byo",
      p_last4: "byo1",
      p_created_by: userId,
    });
    if (error) throw new Error(error.message);

    const page = await newPage(browser);
    const dialog = await submitEvalRun(page);
    // The managed-paused refusal must NOT appear — the run is accepted (the
    // dialog closes on success).
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.context().close();

    // Remove the key so the recovery test exercises the managed path again.
    await db.from("provider_keys").delete().eq("org_id", orgId);
  });

  test("paying the invoice restores managed runs automatically (no human in the loop)", async ({
    browser,
    request,
  }) => {
    // The retry/manual pay succeeds — Stripe fires invoice.paid for the managed
    // invoice; the webhook clears the flag with no further action.
    await postManagedInvoiceEvent(request, "invoice.paid", 8);
    expect(await managedFailedAt()).toBeNull();

    const page = await newPage(browser);
    const dialog = await submitEvalRun(page);
    // Managed runs resume: the run is accepted (no managed-paused refusal).
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.context().close();
  });
});
