import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import {
  CONTRIBUTOR_A,
  READONLY_A,
  CONTRIBUTOR_B,
  ANON_STATE,
  makeAdminClient,
  readSeed,
} from "./constants";

// The e2e stack runs with placeholder Stripe keys, so we can't drive the hosted
// Checkout page — but we don't need to. Billing state is read from the local
// mirror, which the webhook owns, so we exercise the real path by POSTing a
// genuinely-signed subscription event (with a price id that maps to a plan) and
// asserting the pricing page reflects it. The Stripe SDK here only computes an
// HMAC; it never calls the API.
const signer = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const BUILDER_PRICE = process.env.STRIPE_PRICE_BUILDER ?? "";

function activeSubscriptionEvent(orgId: string, priceId: string): string {
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
        items: { data: [{ price: { id: priceId } }] },
      },
    },
  });
}

test.describe("landing page: pricing link visibility", () => {
  test("a signed-out visitor can reach /pricing from the landing nav", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: ANON_STATE });
    const page = await ctx.newPage();
    await page.goto("/");
    const pricing = page.getByRole("link", { name: "Pricing" });
    await expect(pricing).toBeVisible();
    await pricing.click();
    await expect(page).toHaveURL(/\/pricing$/);
    await expect(page.getByRole("heading", { name: "Builder" })).toBeVisible();
    await ctx.close();
  });

  test("a signed-in unsubscribed user sees the pricing link", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Pricing" })).toBeVisible();
    await ctx.close();
  });
});

test.describe("pricing page: plan rendering & checkout authorization", () => {
  test("a Contributor on the Free plan sees Subscribe controls for paid plans", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/pricing");

    // All four plan columns render from the constants. Match exactly: the hero
    // h1 ("Pricing that scales with your evals") substring-collides with the
    // "Scale" plan heading otherwise, tripping strict mode.
    await expect(
      page.getByRole("heading", { name: "Free", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Builder", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Scale", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Enterprise", exact: true })
    ).toBeVisible();

    // Glossary vocabulary, never "GEPA".
    await expect(page.getByText(/Optimization Runs/).first()).toBeVisible();
    await expect(page.getByText(/GEPA/)).toHaveCount(0);

    // Team A has no subscription → Free is the current plan, paid plans offer Subscribe.
    await expect(page.getByRole("button", { name: "Subscribe" })).toHaveCount(2);
    await expect(page.getByText("Current plan")).toBeVisible();

    // Enterprise is contact-only.
    await expect(page.getByRole("link", { name: "Contact sales" })).toBeVisible();
    await ctx.close();
  });

  test("a Readonly Member cannot start checkout — no Subscribe controls", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: READONLY_A.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/pricing");
    await expect(page.getByRole("button", { name: "Subscribe" })).toHaveCount(0);
    await expect(page.getByText("Contributors only").first()).toBeVisible();
    await ctx.close();
  });
});

test.describe("pricing page: mirror reflects the subscribed plan", () => {
  // This test POSTs a webhook that writes an `active` customers row for Team B
  // and a billing_events ledger entry (keyed on the stable event id). Without
  // cleanup both outlive the run and poison the next one: the stale customers
  // row makes the landing-page specs see Team B as subscribed, and the stale
  // ledger row makes the webhook a no-op replay (so the re-POST never
  // re-subscribes). Delete both so repeat local runs are self-healing; CI uses
  // an ephemeral DB and is unaffected.
  test.afterAll(async () => {
    if (!SECRET || !BUILDER_PRICE) return; // the test was skipped — nothing written
    const supabase = makeAdminClient();
    if (!supabase) return;
    let teamBOrgId: string;
    try {
      ({ teamBOrgId } = readSeed());
    } catch {
      return; // no seed file — global setup never ran, so nothing was written
    }
    const [customers, events] = await Promise.all([
      supabase.from("customers").delete().eq("org_id", teamBOrgId),
      supabase
        .from("billing_events")
        .delete()
        .eq("stripe_event_id", `evt_e2e_${teamBOrgId}`),
    ]);
    // supabase-js reports failures in the result, not by throwing — surface
    // them loudly, or the stale state this hook exists to remove survives.
    const failure = customers.error ?? events.error;
    if (failure) {
      throw new Error(`billing e2e cleanup failed: ${failure.message}`);
    }
  });

  test("a signed subscription webhook subscribes one Team to its plan, leaving others untouched", async ({
    browser,
    request,
  }) => {
    test.skip(
      !SECRET || !BUILDER_PRICE,
      "STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_BUILDER not configured for e2e"
    );
    const { teamBOrgId } = readSeed();

    const raw = activeSubscriptionEvent(teamBOrgId, BUILDER_PRICE);
    const sig = signer.webhooks.generateTestHeaderString({
      payload: raw,
      secret: SECRET,
    });
    const res = await request.post("/api/webhooks/stripe", {
      headers: { "stripe-signature": sig, "content-type": "application/json" },
      data: raw,
    });
    expect(res.status()).toBe(200);

    // Team B is now on Builder: that card shows Current plan, and Builder no
    // longer offers Subscribe (Scale still does).
    const ctxB = await browser.newContext({
      storageState: CONTRIBUTOR_B.storageState,
    });
    const pageB = await ctxB.newPage();
    await pageB.goto("/pricing");
    await expect(pageB.getByText("Current plan")).toBeVisible();
    await expect(pageB.getByRole("button", { name: "Subscribe" })).toHaveCount(1);
    // ...and being subscribed hides the landing-page pricing link.
    await pageB.goto("/");
    await expect(pageB.getByRole("link", { name: "Pricing" })).toHaveCount(0);
    await ctxB.close();

    // The unrelated Team A is untouched — still on Free, still offered both
    // plans, and still shown the pricing link on the landing page.
    const ctxA = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const pageA = await ctxA.newPage();
    await pageA.goto("/pricing");
    await expect(pageA.getByRole("button", { name: "Subscribe" })).toHaveCount(2);
    await pageA.goto("/");
    await expect(pageA.getByRole("link", { name: "Pricing" })).toBeVisible();
    await ctxA.close();
  });
});
