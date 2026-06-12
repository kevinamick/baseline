import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import {
  CONTRIBUTOR_A,
  READONLY_A,
  CONTRIBUTOR_B,
  CONTRIBUTOR_C,
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
const SCALE_PRICE = process.env.STRIPE_PRICE_SCALE ?? "";

function subscriptionEvent(
  orgId: string,
  priceId: string,
  opts: {
    status?: string;
    idSuffix?: string;
    created?: number;
    cancelAtPeriodEnd?: boolean;
  } = {}
): string {
  return JSON.stringify({
    id: `evt_e2e_${orgId}${opts.idSuffix ?? ""}`,
    // The mirror's recency guard drops events older than the last applied one,
    // so later phases must pass a larger `created`.
    created: opts.created ?? 1_700_000_000,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_${orgId}`,
        customer: `cus_${orgId}`,
        status: opts.status ?? "active",
        cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
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
    // NOT cleaned: the grant/upgrade ledger entries reconciliation wrote for
    // the mirrored period — the ledgers are append-only even to service_role
    // (#180). Harmless on repeat runs: the event's period is fixed, so the
    // idempotent grant + anti-farming delta converge on the same 500k balance,
    // and Free-tier periods anchor elsewhere (creation anniversary), so no
    // other spec reads this period.
    const [customers, events] = await Promise.all([
      supabase.from("customers").delete().eq("org_id", teamBOrgId),
      supabase
        .from("billing_events")
        .delete()
        .in("stripe_event_id", [
          `evt_e2e_${teamBOrgId}`,
          `evt_e2e_${teamBOrgId}_past_due`,
          `evt_e2e_${teamBOrgId}_upgrade`,
          `evt_e2e_${teamBOrgId}_cancel_sched`,
          `evt_e2e_${teamBOrgId}_canceled`,
        ]),
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
      !SECRET || !BUILDER_PRICE || !SCALE_PRICE,
      "STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_* not configured for e2e"
    );
    const { teamBOrgId } = readSeed();

    async function postEvent(raw: string) {
      const sig = signer.webhooks.generateTestHeaderString({
        payload: raw,
        secret: SECRET,
      });
      const res = await request.post("/api/webhooks/stripe", {
        headers: { "stripe-signature": sig, "content-type": "application/json" },
        data: raw,
      });
      expect(res.status()).toBe(200);
    }

    await postEvent(subscriptionEvent(teamBOrgId, BUILDER_PRICE));

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

    // The billing page reflects the same mirror (#191): plan card with the
    // subscribed plan and the portal entry point. The portal session itself
    // needs a real Stripe key, so e2e stops at the button; the action's
    // params/authz are covered by unit tests with the Stripe client mocked.
    await pageB.goto("/settings/billing");
    const planCardB = pageB.getByTestId("plan-card");
    await expect(planCardB).toContainText("Builder");
    await expect(planCardB).toContainText(/Renews/);
    await expect(planCardB.getByRole("button", { name: "Manage billing" })).toBeVisible();
    await expect(pageB.getByTestId("payment-failed-banner")).toHaveCount(0);
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

    // Phase 2: the payment fails. The plan card keeps naming the subscribed
    // plan — with a "Payment failed" chip and the recovery banner — rather
    // than silently flooring to Free (the quota does floor; the card doesn't).
    await postEvent(
      subscriptionEvent(teamBOrgId, BUILDER_PRICE, {
        status: "past_due",
        idSuffix: "_past_due",
        created: 1_700_000_100,
      })
    );

    const ctxB2 = await browser.newContext({
      storageState: CONTRIBUTOR_B.storageState,
    });
    const pageB2 = await ctxB2.newPage();
    await pageB2.goto("/settings/billing");
    const planCard2 = pageB2.getByTestId("plan-card");
    await expect(planCard2).toContainText("Builder");
    await expect(planCard2.getByTestId("plan-status-chip")).toHaveText("Payment failed");
    await expect(pageB2.getByTestId("payment-failed-banner")).toBeVisible();
    await expect(planCard2.getByRole("button", { name: "Manage billing" })).toBeVisible();

    // Phase 3 (#182): an immediate upgrade to Scale. The mirror rolls the
    // price, and grant reconciliation lands the delta into the SAME period —
    // the new quota is usable right away (100k grant + 400k upgrade = 500k).
    await postEvent(
      subscriptionEvent(teamBOrgId, SCALE_PRICE, {
        idSuffix: "_upgrade",
        created: 1_700_000_300,
      })
    );
    await pageB2.goto("/settings/billing");
    await expect(planCard2).toContainText("Scale");
    await expect(pageB2.getByTestId("point-balance")).toHaveText(
      /^500,000\s*of 500,000 remaining$/
    );

    // Phase 4 (#182): a scheduled Cancellation renders as a pending state with
    // the reversible "Keep my plan" — the card keeps naming the paid plan.
    await postEvent(
      subscriptionEvent(teamBOrgId, SCALE_PRICE, {
        idSuffix: "_cancel_sched",
        created: 1_700_000_400,
        cancelAtPeriodEnd: true,
      })
    );
    await pageB2.goto("/settings/billing");
    await expect(pageB2.getByTestId("plan-subline")).toHaveText(
      "Scale until December 14, 2023, then Free"
    );
    await expect(pageB2.getByRole("button", { name: "Keep my plan" })).toBeVisible();
    await expect(pageB2.getByTestId("cancel-plan")).toHaveCount(0);

    // Phase 5 (#182): the cancellation executes (subscription ends). The card
    // floors to Free, the stale pending line disappears, and the portal stays
    // reachable for invoice history.
    await postEvent(
      subscriptionEvent(teamBOrgId, SCALE_PRICE, {
        idSuffix: "_canceled",
        created: 1_700_000_500,
        status: "canceled",
        cancelAtPeriodEnd: true,
      })
    );
    await pageB2.goto("/settings/billing");
    await expect(planCard2).toContainText("Free");
    await expect(pageB2.getByTestId("plan-subline")).toHaveText("No active subscription");
    await expect(pageB2.getByRole("button", { name: "Keep my plan" })).toHaveCount(0);
    await expect(planCard2.getByRole("button", { name: "Manage billing" })).toBeVisible();
    await ctxB2.close();
  });
});

test.describe("plan changes: the seat wall (#182)", () => {
  test("cancelling with more members than Free seats shows the wall, not a schedule", async ({
    browser,
  }) => {
    const supabase = makeAdminClient();
    test.skip(!supabase, "needs the local Supabase env");
    const { teamAOrgId, teamCOrgId } = readSeed();

    // Borrow a Team A member into Team C (multi-org membership) so Team C has 2.
    const { data: donor } = await supabase!
      .from("memberships")
      .select("user_id")
      .eq("org_id", teamAOrgId)
      .eq("role", "member")
      .limit(1)
      .single();
    await supabase!
      .from("memberships")
      .insert({ org_id: teamCOrgId, user_id: donor!.user_id, role: "member" });

    try {
      const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
      const page = await ctx.newPage();
      await page.goto("/settings/billing");
      await page.getByTestId("cancel-plan").click();
      // The wall: scheduling is blocked until membership fits the Free cap.
      await expect(page.getByText(/Remove members on the Team settings page/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Got it" })).toBeVisible();
      await page.getByRole("button", { name: "Got it" }).click();
      await ctx.close();
    } finally {
      await supabase!
        .from("memberships")
        .delete()
        .eq("org_id", teamCOrgId)
        .eq("user_id", donor!.user_id);
    }
  });
});

test.describe("seat cap at the source (#182)", () => {
  test("a Free Team cannot send invites beyond the cap", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_A.storageState });
    const page = await ctx.newPage();
    await page.goto("/settings/team");
    await page.getByLabel(/email/i).fill("third@baseline.test");
    await page.getByRole("button", { name: /invite/i }).click();
    await expect(
      page.getByText("The Free plan includes 1 seat — upgrade to invite teammates.")
    ).toBeVisible();
    await ctx.close();
  });
});

test.describe("billing page: plan card for never-subscribed Teams", () => {
  test("a Free Team sees its plan and a pricing link, never the portal button", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/settings/billing");

    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toContainText("Free");
    await expect(planCard).toContainText("$0/mo");
    await expect(planCard.getByRole("link", { name: /Compare plans/ })).toBeVisible();
    // No Stripe customer → nothing for the portal to manage (fail-closed).
    await expect(planCard.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
    await ctx.close();
  });
});
