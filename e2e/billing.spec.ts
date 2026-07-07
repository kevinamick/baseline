import { test, expect } from "./fixtures";
import Stripe from "stripe";
import { PLANS } from "../src/lib/billing/plans";
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
const SCALE_POINTS = PLANS.scale.includedEvalPoints.toLocaleString("en-US");

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
    // The nav pill is the signed-out entry to pricing. Scope to the banner and
    // match exactly — "Pricing" also appears in the footer and substring-matches
    // the final CTA's "View pricing".
    const pricing = page
      .getByRole("banner")
      .getByRole("link", { name: "Pricing", exact: true });
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
    // A signed-in, unsubscribed Contributor gets the plan link in the nav. The
    // redesign labels it "View plans" (→ /pricing) for signed-in users;
    // "Pricing" is the signed-out label.
    await expect(
      page.getByRole("banner").getByRole("link", { name: "View plans" })
    ).toHaveAttribute("href", "/pricing");
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
    // Five webhook phases + eight page loads: under a fully-parallel local
    // run against the dev server this legitimately exceeds the default 30s
    // (CI serves a production build and is unaffected). slow() triples it.
    test.slow();
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
    // ...and being subscribed hides the landing nav's plan link ("View plans").
    // The footer keeps a static "Pricing" link for everyone, so scope to the nav.
    await pageB.goto("/");
    await expect(
      pageB.getByRole("banner").getByRole("link", { name: "View plans" })
    ).toHaveCount(0);

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
    // plans, and still shown the nav's plan link on the landing page. Signed-in
    // and unsubscribed, Team A gets the "View plans" nav label; scope to the
    // banner so the static footer "Pricing" link doesn't make the match
    // ambiguous.
    const ctxA = await browser.newContext({
      storageState: CONTRIBUTOR_A.storageState,
    });
    const pageA = await ctxA.newPage();
    await pageA.goto("/pricing");
    await expect(pageA.getByRole("button", { name: "Subscribe" })).toHaveCount(2);
    await pageA.goto("/");
    await expect(
      pageA.getByRole("banner").getByRole("link", { name: "View plans" })
    ).toBeVisible();
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
      // Derived from PLANS so retuning Scale's quota can't strand this spec
      // (stale ledger rows from prior local runs converge on the same total).
      new RegExp(
        `^${SCALE_POINTS}\\s*of ${SCALE_POINTS} remaining$`
      )
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

test.describe("billing page: trial state (ADR-0017 slice 3, #427)", () => {
  // A DEDICATED user + Team, created here and torn down here — never one of
  // the shared seeded Teams. A first version of this spec drove Team C's
  // mirror through trialing → canceled and deleted its `customers` row in
  // cleanup, which broke every spec that assumes Team C is a normal paid
  // Team (optimization gating, no-upsell assertions, and the invitations
  // spec via the Free seat cap) AND tripped the webhook route's identity
  // guard (the seeded row's `cus_seed_…` didn't match this spec's
  // `cus_<orgId>` — a 400, whose failed-worker afterAll then deleted the
  // seeded row). A fresh org has no seeded mirror row, so the webhook upsert
  // path is exercised cleanly and no other spec can observe any of this
  // state.
  const supabase = makeAdminClient();
  const TRIAL_EMAIL = `e2e-trial-427-${Date.now()}@baseline.test`;
  const TRIAL_PASSWORD = "password123";
  let trialOrgId: string | null = null;
  let trialUserId: string | null = null;

  test.beforeAll(async () => {
    if (!supabase || !SECRET || !BUILDER_PRICE) return; // the test will skip
    const { data: userRes, error: userErr } =
      await supabase.auth.admin.createUser({
        email: TRIAL_EMAIL,
        password: TRIAL_PASSWORD,
        email_confirm: true,
      });
    if (userErr) throw new Error(`trial user create failed: ${userErr.message}`);
    trialUserId = userRes.user.id;
    await supabase
      .from("users")
      .upsert({ id: trialUserId }, { onConflict: "id" });

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .insert({ name: "Trial e2e team (#427)" })
      .select("id")
      .single();
    if (orgErr || !org) {
      throw new Error(`trial org create failed: ${orgErr?.message}`);
    }
    trialOrgId = org.id;

    const { error: memberErr } = await supabase
      .from("memberships")
      .insert({ org_id: trialOrgId, user_id: trialUserId, role: "admin" });
    if (memberErr) {
      throw new Error(`trial membership failed: ${memberErr.message}`);
    }
  });

  test.afterAll(async () => {
    if (!supabase) return;
    if (trialOrgId) {
      // The org cascade takes memberships and org-scoped data; the customers
      // mirror row and the billing_events ledger rows are keyed by ids no
      // other spec uses, so repeat local runs are self-healing.
      const [customers, events, org] = await Promise.all([
        supabase.from("customers").delete().eq("org_id", trialOrgId),
        supabase
          .from("billing_events")
          .delete()
          .in("stripe_event_id", [
            `evt_e2e_${trialOrgId}_trial427`,
            `evt_e2e_${trialOrgId}_trial427_ended`,
          ]),
        supabase.from("organizations").delete().eq("id", trialOrgId),
      ]);
      const failure = customers.error ?? events.error ?? org.error;
      if (failure) {
        throw new Error(`trial e2e cleanup failed: ${failure.message}`);
      }
    }
    if (trialUserId) {
      await supabase.auth.admin.deleteUser(trialUserId).catch(() => undefined);
    }
  });

  test("a trialing subscription shows the Trial chip and trial-end date, then floors to Free when the trial ends without payment", async ({
    browser,
    request,
  }) => {
    test.skip(
      !supabase || !SECRET || !BUILDER_PRICE,
      "local Supabase env / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_BUILDER not configured for e2e"
    );
    const orgId = trialOrgId!;

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

    // A card-required trial (ADR-0017 slice 3, #427): the mirror already
    // treats `trialing` as active (billing/state.ts's ACTIVE_STATUSES), so
    // paid access — including the plan card naming Builder — is granted
    // before any payment is captured. The card gets its own Trial chip and
    // subline rather than the paymentFailed/renews copy.
    await postEvent(
      subscriptionEvent(orgId, BUILDER_PRICE, {
        status: "trialing",
        idSuffix: "_trial427",
        created: 1_700_100_000,
      })
    );

    // The dedicated user is not a seeded role, so it has no saved
    // storageState — sign in through the real form (the e2e environment
    // runs with RATE_LIMIT_ENABLED=false, same as global-setup's own
    // repeated sign-ins rely on).
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(TRIAL_EMAIL);
    await page.getByLabel("Password").fill(TRIAL_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto("/settings/billing");
    const planCard = page.getByTestId("plan-card");
    await expect(planCard).toContainText("Builder");
    await expect(planCard.getByTestId("plan-status-chip")).toHaveText("Trial");
    await expect(page.getByTestId("plan-subline")).toHaveText(/^Trial ends /);
    await expect(page.getByTestId("payment-failed-banner")).toHaveCount(0);

    // Trial ends without a successful payment: Stripe's real dunning flow
    // eventually cancels the subscription. The mirror floors the Team back
    // to Free — an ENDED status (#182), not merely a payment-failure state —
    // so the card itself floors, same webhook-driven path the existing
    // Team B cancellation phase above already proves.
    await postEvent(
      subscriptionEvent(orgId, BUILDER_PRICE, {
        status: "canceled",
        idSuffix: "_trial427_ended",
        created: 1_700_100_100,
        cancelAtPeriodEnd: true,
      })
    );
    await page.goto("/settings/billing");
    await expect(planCard).toContainText("Free");
    await expect(page.getByTestId("plan-subline")).toHaveText(
      "No active subscription"
    );
    await ctx.close();
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
    // PR #344: Free plan disables the invite form — no server round-trip needed.
    await expect(page.getByTestId("invite-free-blocked")).toBeVisible();
    await expect(page.getByRole("button", { name: /invite/i })).toBeDisabled();
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
    // Captain review on #360: Compare Plans button removed; upgrade CTA remains.
    await expect(planCard.getByTestId("upgrade-cta")).toBeVisible();
    // No Stripe customer → nothing for the portal to manage (fail-closed).
    await expect(planCard.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
    await ctx.close();
  });
});

test.describe("pending Access Code benefit notice & mismatch warning (ADR-0017 slice 4, #428)", () => {
  // A DEDICATED user + Team, same isolation rationale as the "trial state"
  // block above: this writes a real access_code_redemptions row against a
  // real Team, and no shared seeded Team should carry that state into other
  // specs (e.g. the "never-subscribed Teams" plan-card assertion just above).
  //
  // The notice's COUPON line (describeCoupon → stripe.coupons.retrieve) is
  // NOT covered here: e2e runs with a placeholder Stripe key
  // (STRIPE_SECRET_KEY=sk_test_placeholder), so a real coupon lookup always
  // fails closed — the same reason this suite's header comment says real
  // Checkout-session creation can't be driven from e2e. The coupon
  // composition is unit-tested directly (coupon-summary.test.ts,
  // pending-benefit.test.ts) with the Stripe client mocked; this file proves
  // the TRIAL half of the notice end to end, plus the mismatch dialog (which
  // never calls Stripe on Cancel — only Confirm would, and Confirm is
  // deliberately not exercised here for the same placeholder-key reason).
  const supabase = makeAdminClient();
  const BENEFIT_EMAIL = `e2e-benefit-428-${Date.now()}@baseline.test`;
  const BENEFIT_PASSWORD = "password123";
  let benefitOrgId: string | null = null;
  let benefitUserId: string | null = null;
  const createdAccessCodeIds: string[] = [];

  test.beforeAll(async () => {
    if (!supabase) return; // the tests will skip
    const { data: userRes, error: userErr } =
      await supabase.auth.admin.createUser({
        email: BENEFIT_EMAIL,
        password: BENEFIT_PASSWORD,
        email_confirm: true,
      });
    if (userErr) throw new Error(`benefit user create failed: ${userErr.message}`);
    benefitUserId = userRes.user.id;
    await supabase.from("users").upsert({ id: benefitUserId }, { onConflict: "id" });

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .insert({ name: "Pending benefit e2e team (#428)" })
      .select("id")
      .single();
    if (orgErr || !org) throw new Error(`benefit org create failed: ${orgErr?.message}`);
    benefitOrgId = org.id;

    const { error: memberErr } = await supabase
      .from("memberships")
      .insert({ org_id: benefitOrgId, user_id: benefitUserId, role: "admin" });
    if (memberErr) throw new Error(`benefit membership failed: ${memberErr.message}`);
  });

  test.afterAll(async () => {
    if (!supabase) return;
    if (benefitOrgId) {
      await supabase.from("organizations").delete().eq("id", benefitOrgId);
    }
    if (benefitUserId) {
      await supabase.auth.admin.deleteUser(benefitUserId).catch(() => undefined);
    }
    if (createdAccessCodeIds.length > 0) {
      // access_code_redemptions cascades off access_codes.
      await supabase.from("access_codes").delete().in("id", createdAccessCodeIds);
    }
  });

  /** Mints a code and binds a redemption directly to the dedicated Team. */
  async function mintAndBindCode(overrides: {
    trialDays?: number | null;
    planSlug?: string | null;
  }): Promise<string> {
    const code = `E2E-BENEFIT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const { data: accessCode, error: mintError } = await supabase!
      .from("access_codes")
      .insert({
        code,
        max_redemptions: 5,
        trial_days: overrides.trialDays ?? null,
        plan_slug: overrides.planSlug ?? null,
      })
      .select("id")
      .single();
    if (mintError || !accessCode) {
      throw new Error(`failed to mint e2e access code: ${mintError?.message}`);
    }
    createdAccessCodeIds.push(accessCode.id);

    const { error: redemptionError } = await supabase!
      .from("access_code_redemptions")
      .insert({
        access_code_id: accessCode.id,
        user_id: benefitUserId!,
        org_id: benefitOrgId!,
      });
    if (redemptionError) {
      throw new Error(`failed to bind e2e redemption: ${redemptionError.message}`);
    }
    return accessCode.id;
  }

  test("billing page shows the pending trial notice, and it disappears once the grant is consumed", async ({
    browser,
  }) => {
    test.skip(!supabase, "needs the local Supabase env");
    await mintAndBindCode({ trialDays: 30, planSlug: "builder" });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(BENEFIT_EMAIL);
    await page.getByLabel("Password").fill(BENEFIT_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto("/settings/billing");
    const notice = page.getByTestId("pending-benefit-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("A 30-day trial once you subscribe");
    await expect(page.getByTestId("pending-benefit-restriction")).toHaveText(
      "Applies to the Builder plan."
    );

    // Simulate the grant being consumed (a real checkout can't be driven in
    // e2e — see the describe block's header comment). The notice's own
    // "nothing shows once consumed" behavior is a plain read of
    // benefit_consumed_at, so flipping it directly proves the same thing a
    // real checkout's consume step would.
    await supabase!
      .from("access_code_redemptions")
      .update({ benefit_consumed_at: new Date().toISOString() })
      .eq("org_id", benefitOrgId!);

    await page.goto("/settings/billing");
    await expect(page.getByTestId("pending-benefit-notice")).toHaveCount(0);

    await ctx.close();
  });

  test("pricing page warns before checkout on a mismatched plan, and Cancel forfeits nothing", async ({
    browser,
  }) => {
    test.skip(!supabase, "needs the local Supabase env");
    await mintAndBindCode({ trialDays: 14, planSlug: "builder" });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(BENEFIT_EMAIL);
    await page.getByLabel("Password").fill(BENEFIT_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto("/pricing");

    // Builder is the restricted (matching) plan: a plain progressive-
    // enhancement form, no confirm-gated control at all.
    const builderCard = page
      .getByRole("heading", { name: "Builder", exact: true })
      .locator("..")
      .locator("..");
    await expect(builderCard.getByTestId("mismatch-subscribe")).toHaveCount(0);
    await expect(builderCard.getByRole("button", { name: "Subscribe" })).toBeVisible();

    // Scale mismatches the code's Builder restriction: Subscribe opens the
    // forfeit warning instead of submitting straight through.
    const scaleCard = page
      .getByRole("heading", { name: "Scale", exact: true })
      .locator("..")
      .locator("..");
    await scaleCard.getByTestId("mismatch-subscribe").click();

    await expect(
      page.getByRole("heading", { name: "This code is for a different plan" })
    ).toBeVisible();
    await expect(
      page.getByText(/applies to the Builder plan/i)
    ).toBeVisible();

    await page.getByRole("button", { name: "Go back" }).click();
    await expect(
      page.getByRole("heading", { name: "This code is for a different plan" })
    ).toHaveCount(0);

    // Cancel consumed nothing — the grant is still pending for a later
    // matching-plan checkout.
    const { data: row } = await supabase!
      .from("access_code_redemptions")
      .select("benefit_consumed_at")
      .eq("org_id", benefitOrgId!)
      .single();
    expect(row?.benefit_consumed_at).toBeNull();

    await ctx.close();
  });
});
