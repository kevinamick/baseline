import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockAuth, mockIsTeamAdmin, mockCreate, mockRedirect, mockTrack } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockIsTeamAdmin: vi.fn(),
    mockCreate: vi.fn(),
    mockRedirect: vi.fn(),
    mockTrack: vi.fn(),
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

import { createCheckoutSession } from "../checkout";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_ID = "price_test";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mockCreate.mockResolvedValue({ url: "https://checkout.stripe/session" });
});

describe("createCheckoutSession", () => {
  it("rejects when not signed in", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    await expect(createCheckoutSession("org-1")).rejects.toThrow("Not signed in");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a forged/foreign org id the caller is not a Contributor of", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(false);

    await expect(createCheckoutSession("org-someone-else")).rejects.toThrow(
      "Not authorized"
    );
    // Verified against membership for the *exact* org id the caller passed.
    expect(mockIsTeamAdmin).toHaveBeenCalledWith("org-someone-else", "user-1");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a Readonly Member (non-admin) of the Team", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(false);
    await expect(createCheckoutSession("org-1")).rejects.toThrow("Not authorized");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a Team-scoped session carrying the org id two ways", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockIsTeamAdmin.mockResolvedValue(true);

    await createCheckoutSession("org-1");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        client_reference_id: "org-1",
        subscription_data: { metadata: { org_id: "org-1" } },
        line_items: [{ price: "price_test", quantity: 1 }],
      })
    );
    expect(mockRedirect).toHaveBeenCalledWith("https://checkout.stripe/session");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.checkout_started",
        props: expect.objectContaining({ team_id: "org-1" }),
      }),
      expect.objectContaining({ userId: "user-1" })
    );
  });
});
