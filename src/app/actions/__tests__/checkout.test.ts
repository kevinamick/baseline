import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockAuth, mockCreate, mockRedirect, mockTrack } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockRedirect: vi.fn(),
  mockTrack: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockAuth }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/stripe", () => ({
  stripe: { checkout: { sessions: { create: mockCreate } } },
}));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
// Plans module is NOT mocked — slug validation + price resolution are exercised
// for real; the price comes from env, never the client.

// #449: getTranslations has no request scope in a node test, so it throws and
// the trial-disclosure helper falls back to the English catalog — exercise
// that real fallback path rather than mocking it away.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => {
    throw new Error("no request scope in this test");
  }),
}));

import { createCheckoutSession } from "../checkout";

const CONTRIBUTOR = { userId: "user-1", orgId: "org-1", canWrite: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
  process.env.STRIPE_PRICE_SCALE = "price_scale_live";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mockCreate.mockResolvedValue({ url: "https://checkout.stripe/session" });
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
    mockAuth.mockResolvedValue(CONTRIBUTOR);
    await expect(createCheckoutSession("org-1", "enterprise")).rejects.toThrow(
      "Not a subscribable plan"
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects the Free plan (no checkout)", async () => {
    mockAuth.mockResolvedValue(CONTRIBUTOR);
    await expect(createCheckoutSession("org-1", "free")).rejects.toThrow(
      "Not a subscribable plan"
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a forged/foreign org id that is not the Local Workspace (ADR-0020)", async () => {
    mockAuth.mockResolvedValue(CONTRIBUTOR);
    await expect(
      createCheckoutSession("org-someone-else", "builder")
    ).rejects.toThrow("Not authorized");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves the price from the plan slug server-side (client can't choose a price)", async () => {
    mockAuth.mockResolvedValue(CONTRIBUTOR);

    await createCheckoutSession("org-1", "scale");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_scale_live", quantity: 1 }],
        client_reference_id: "org-1",
        subscription_data: { metadata: { org_id: "org-1" } },
      })
    );
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("discounts");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.checkout_started" }),
      expect.objectContaining({ userId: "user-1" })
    );
    expect(mockRedirect).toHaveBeenCalledWith("https://checkout.stripe/session");
  });

  it("uses the Builder price for the Builder plan", async () => {
    mockAuth.mockResolvedValue(CONTRIBUTOR);

    await createCheckoutSession("org-1", "builder");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_builder_live", quantity: 1 }],
      })
    );
  });
});
