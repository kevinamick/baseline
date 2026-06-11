import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import { CONTRIBUTOR_A, READONLY_A, CONTRIBUTOR_B, readSeed } from "./constants";

// The e2e stack runs with placeholder Stripe keys, so we can't drive the hosted
// Checkout page — but we don't need to. Billing state is read from the local
// mirror, which the webhook owns, so we exercise the real path by POSTing a
// genuinely-signed subscription event to the running app (same secret the server
// verifies against) and asserting the UI reflects it. The Stripe SDK here only
// computes an HMAC; it never calls the API.
const signer = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

function activeSubscriptionEvent(orgId: string): string {
  return JSON.stringify({
    id: `evt_e2e_${orgId}`,
    created: 1_700_000_000,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_${orgId}`,
        customer: `cus_${orgId}`,
        status: "active",
        metadata: { org_id: orgId },
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        items: { data: [{ price: { id: "price_e2e_builder" } }] },
      },
    },
  });
}

test.describe("billing: checkout authorization", () => {
  test("a Contributor of an unsubscribed Team sees the Subscribe control", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
    await ctx.close();
  });

  test("a Readonly Member cannot start checkout — no Subscribe control", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: READONLY_A.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Subscribe" })).toHaveCount(0);
    await ctx.close();
  });
});

test.describe("billing: mirror reflects subscription", () => {
  test("a signed subscription webhook subscribes one Team, leaving others untouched", async ({
    browser,
    request,
  }) => {
    test.skip(!SECRET, "STRIPE_WEBHOOK_SECRET not configured for e2e");
    const { teamBOrgId } = readSeed();

    const raw = activeSubscriptionEvent(teamBOrgId);
    const sig = signer.webhooks.generateTestHeaderString({
      payload: raw,
      secret: SECRET,
    });
    const res = await request.post("/api/webhooks/stripe", {
      headers: { "stripe-signature": sig, "content-type": "application/json" },
      data: raw,
    });
    expect(res.status()).toBe(200);

    // Team B's Contributor now sees the subscribed state...
    const ctxB = await browser.newContext({
      storageState: CONTRIBUTOR_B.storageState,
    });
    const pageB = await ctxB.newPage();
    await pageB.goto("/");
    await expect(pageB.getByText("Subscribed ✓")).toBeVisible();
    await ctxB.close();

    // ...while the unrelated Team A is untouched — still offered Subscribe.
    const ctxA = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const pageA = await ctxA.newPage();
    await pageA.goto("/");
    await expect(pageA.getByRole("button", { name: "Subscribe" })).toBeVisible();
    await ctxA.close();
  });
});
