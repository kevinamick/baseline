import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockMaybeSingle } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
}));

// supabaseAdmin.from("customers").select(...).eq(...).maybeSingle()
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
    }),
  },
}));

import { getBillingState, isActiveStatus } from "../state";

beforeEach(() => vi.clearAllMocks());

// Stripe's full subscription status set, with the expected access decision.
const STATUS_CASES: Array<[string, boolean]> = [
  ["active", true],
  ["trialing", true],
  ["past_due", false],
  ["canceled", false],
  ["unpaid", false],
  ["incomplete", false],
  ["incomplete_expired", false],
  ["paused", false],
];

describe("isActiveStatus", () => {
  it.each(STATUS_CASES)("status %s → active=%s", (status, expected) => {
    expect(isActiveStatus(status)).toBe(expected);
  });

  it("treats null/undefined as not active (fail closed)", () => {
    expect(isActiveStatus(null)).toBe(false);
    expect(isActiveStatus(undefined)).toBe(false);
  });
});

describe("getBillingState", () => {
  it("blocks a null org without touching the database", async () => {
    const state = await getBillingState(null);
    expect(state.active).toBe(false);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("blocks a Team with no mirror row and floors it to the Free plan", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null });
    const state = await getBillingState("org-1");
    expect(state).toEqual({
      active: false,
      plan: "free",
      status: null,
      priceId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
  });

  it("names the paid plan when active, mapped from the mirrored price id", async () => {
    process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
    mockMaybeSingle.mockResolvedValue({
      data: {
        status: "active",
        stripe_price_id: "price_builder_live",
        current_period_start: "2026-06-01T00:00:00Z",
        current_period_end: "2026-07-01T00:00:00Z",
      },
    });
    const state = await getBillingState("org-1");
    expect(state.active).toBe(true);
    expect(state.plan).toBe("builder");
    // The mirrored period bounds anchor a paid Team's point period (#180);
    // dropping either from the select would silently shift grants to the
    // creation-anniversary fallback.
    expect(state.currentPeriodStart).toBe("2026-06-01T00:00:00Z");
    expect(state.currentPeriodEnd).toBe("2026-07-01T00:00:00Z");
  });

  it("floors a non-active subscription to Free even if a paid price is mirrored", async () => {
    process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
    mockMaybeSingle.mockResolvedValue({
      data: {
        status: "past_due",
        stripe_price_id: "price_builder_live",
        current_period_end: "2026-07-01T00:00:00Z",
      },
    });
    const state = await getBillingState("org-1");
    expect(state.active).toBe(false);
    expect(state.plan).toBe("free");
  });

  it.each(STATUS_CASES)(
    "resolves active=%s for mirrored status %s",
    async (status, expected) => {
      mockMaybeSingle.mockResolvedValue({
        data: {
          status,
          stripe_price_id: "price_1",
          current_period_end: "2026-07-01T00:00:00Z",
        },
      });
      const state = await getBillingState("org-1");
      expect(state.active).toBe(expected);
      expect(state.status).toBe(status);
      expect(state.priceId).toBe("price_1");
    }
  );
});
