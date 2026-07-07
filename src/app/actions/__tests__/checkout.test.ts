import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockAuth,
  mockIsTeamAdmin,
  mockCreate,
  mockRedirect,
  mockTrack,
  mockEvaluateBenefit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockIsTeamAdmin: vi.fn(),
  mockCreate: vi.fn(),
  mockRedirect: vi.fn(),
  mockTrack: vi.fn(),
  mockEvaluateBenefit: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockAuth }));
vi.mock("@/lib/auth/teams", () => ({ isTeamAdmin: mockIsTeamAdmin }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/stripe", () => ({
  stripe: { checkout: { sessions: { create: mockCreate } } },
}));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
// Access-code benefit evaluation (ADR-0017 slice 3, #427) is mocked here so
// these pre-existing tests exercise no-grant checkout unchanged; its own
// evaluate/consume behavior is unit-tested directly in
// access-codes/__tests__/checkout-benefit.test.ts.
vi.mock("@/lib/access-codes/checkout-benefit", () => ({
  evaluateAndConsumeAccessCodeBenefit: mockEvaluateBenefit,
}));
// Plans module is NOT mocked — slug validation + price resolution are exercised
// for real; the price comes from env, never the client.

// #449: getTranslations has no request scope in a node test, so it throws and
// the trial-disclosure helper falls back to the English catalog — exercise
// that real fallback path rather than mocking it away, mirroring how
// `localizeRunGateError`'s own tests aren't mocked either.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => {
    throw new Error("no request scope in this test");
  }),
}));

import { createCheckoutSession } from "../checkout";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
  process.env.STRIPE_PRICE_SCALE = "price_scale_live";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mockCreate.mockResolvedValue({ url: "https://checkout.stripe/session" });
  mockEvaluateBenefit.mockResolvedValue({
    trialPeriodDays: null,
    stripeCouponId: null,
  });
});

describe("createCheckoutSession", () => {
  it("rejects when not signed in", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    await expect(createCheckoutSession("org-1", "builder")).rejects.toThrow(
      "Not signed in"
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an unknown/retired plan slug before any authz or Stripe call", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    await expect(createCheckoutSession("org-1", "platinum")).rejects.toThrow(
      "Not a subscribable plan"
    );
    expect(mockIsTeamAdmin).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects the Free plan (no checkout)", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    await expect(createCheckoutSession("org-1", "free")).rejects.toThrow(
      "Not a subscribable plan"
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a forged/foreign org id the caller is not a Contributor of", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(false);

    await expect(
      createCheckoutSession("org-someone-else", "builder")
    ).rejects.toThrow("Not authorized");
    expect(mockIsTeamAdmin).toHaveBeenCalledWith("org-someone-else", "user-1");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a Readonly Member (non-admin) of the Team", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(false);
    await expect(createCheckoutSession("org-1", "builder")).rejects.toThrow(
      "Not authorized"
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves the price from the plan slug server-side (client can't choose a price)", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(true);

    await createCheckoutSession("org-1", "scale");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        client_reference_id: "org-1",
        subscription_data: { metadata: { org_id: "org-1" } },
        // From STRIPE_PRICE_SCALE env, not from any client input.
        line_items: [{ price: "price_scale_live", quantity: 1 }],
      })
    );
    expect(mockRedirect).toHaveBeenCalledWith("https://checkout.stripe/session");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.checkout_started",
        props: expect.objectContaining({ team_id: "org-1", plan: "scale" }),
      }),
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it("uses the Builder price for the Builder plan", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(true);
    await createCheckoutSession("org-1", "builder");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_builder_live", quantity: 1 }],
      })
    );
  });

  describe("Access Code trial grant (ADR-0017 slice 3, #427)", () => {
    it("rides a granted trial as subscription_data.trial_period_days", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: 14,
        stripeCouponId: null,
      });

      await createCheckoutSession("org-1", "builder");

      expect(mockEvaluateBenefit).toHaveBeenCalledWith("org-1", "builder");
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: {
            metadata: { org_id: "org-1" },
            trial_period_days: 14,
          },
        })
      );
    });

    it("omits trial_period_days entirely when no benefit applies (default card-required checkout)", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: null,
        stripeCouponId: null,
      });

      await createCheckoutSession("org-1", "builder");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: { metadata: { org_id: "org-1" } },
        })
      );
    });

    // #449: the trial waives the subscription fee only — managed-key usage
    // still bills to the card, so the Checkout page collecting that card
    // must say so plainly (never hidden behind a tooltip).
    it("sets custom_text.submit.message to the trial billing disclosure on a granted trial", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: 14,
        stripeCouponId: null,
      });

      await createCheckoutSession("org-1", "builder");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          custom_text: {
            submit: {
              message:
                "Your trial covers the subscription fee. Managed model usage bills to your card as you use it, during the trial and after.",
            },
          },
        })
      );
    });

    it("omits custom_text entirely when no trial is granted", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: null,
        stripeCouponId: null,
      });

      await createCheckoutSession("org-1", "builder");

      const call = mockCreate.mock.calls[0][0];
      expect(call).not.toHaveProperty("custom_text");
    });
  });

  describe("Access Code discount grant (ADR-0017 slice 4, #428)", () => {
    it("rides a granted coupon as checkout discounts", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: null,
        stripeCouponId: "coupon_launch50",
      });

      await createCheckoutSession("org-1", "builder");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          discounts: [{ coupon: "coupon_launch50" }],
        })
      );
    });

    it("omits discounts entirely when no coupon benefit applies", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: null,
        stripeCouponId: null,
      });

      await createCheckoutSession("org-1", "builder");

      const call = mockCreate.mock.calls[0][0];
      expect(call).not.toHaveProperty("discounts");
    });

    it("composes a trial and a coupon on the same checkout", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockIsTeamAdmin.mockResolvedValue(true);
      mockEvaluateBenefit.mockResolvedValue({
        trialPeriodDays: 14,
        stripeCouponId: "coupon_launch50",
      });

      await createCheckoutSession("org-1", "builder");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: {
            metadata: { org_id: "org-1" },
            trial_period_days: 14,
          },
          discounts: [{ coupon: "coupon_launch50" }],
        })
      );
    });
  });
});
