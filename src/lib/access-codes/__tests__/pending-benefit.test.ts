import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFrom, mockSelect, mockEq, mockIs, mockMaybeSingle, mockLogError, mockRetrieve } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockSelect: vi.fn(),
    mockEq: vi.fn(),
    mockIs: vi.fn(),
    mockMaybeSingle: vi.fn(),
    mockLogError: vi.fn(),
    mockRetrieve: vi.fn(),
  }));

// Read-only chain — no `.update()` should ever be reachable/called here.
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    mockSelect(...args);
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    mockEq(...args);
    return chain;
  };
  chain.is = (...args: unknown[]) => {
    mockIs(...args);
    return chain;
  };
  chain.maybeSingle = () => mockMaybeSingle();
  return {
    supabaseAdmin: {
      from: (...args: unknown[]) => {
        mockFrom(...args);
        return chain;
      },
    },
  };
});
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));
// Stub the network boundary only (Stripe's coupon retrieve) — the real
// describeCoupon/couponBenefitDescriptor composition logic in
// coupon-summary.ts runs unmocked, same idiom as coupon-summary.test.ts.
vi.mock("@/lib/stripe", () => ({
  stripe: { coupons: { retrieve: mockRetrieve } },
}));

import {
  getPendingAccessCodeBenefit,
  getPendingAccessCodeBenefitView,
} from "../pending-benefit";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPendingAccessCodeBenefit", () => {
  it("returns null when there is no unconsumed redemption bound to the org", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await getPendingAccessCodeBenefit("org-1");
    expect(result).toBeNull();
  });

  it("returns the grant fields for an unconsumed redemption", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: {
          trial_days: 14,
          stripe_coupon_id: "coupon_abc",
          plan_slug: "builder",
        },
      },
      error: null,
    });

    const result = await getPendingAccessCodeBenefit("org-1");
    expect(result).toEqual({
      trialDays: 14,
      stripeCouponId: "coupon_abc",
      planSlug: "builder",
    });
    expect(mockEq).toHaveBeenCalledWith("org_id", "org-1");
    expect(mockIs).toHaveBeenCalledWith("benefit_consumed_at", null);
  });

  it("never calls update — this lookup is read-only", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, stripe_coupon_id: null, plan_slug: null },
      },
      error: null,
    });
    // Calling it twice must return the SAME grant both times — nothing here
    // consumes it, unlike evaluateAndConsumeAccessCodeBenefit.
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, stripe_coupon_id: null, plan_slug: null },
      },
      error: null,
    });

    const first = await getPendingAccessCodeBenefit("org-1");
    const second = await getPendingAccessCodeBenefit("org-1");
    expect(first).toEqual(second);
  });

  it("normalizes an unrecognized plan_slug to null", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, stripe_coupon_id: null, plan_slug: "platinum" },
      },
      error: null,
    });

    const result = await getPendingAccessCodeBenefit("org-1");
    expect(result?.planSlug).toBeNull();
  });

  it("handles the embed relation returned as an array", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: [{ trial_days: 7, stripe_coupon_id: null, plan_slug: null }],
      },
      error: null,
    });

    const result = await getPendingAccessCodeBenefit("org-1");
    expect(result?.trialDays).toBe(7);
  });

  it("fails closed and logs when the lookup errors", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "db down" },
    });

    const result = await getPendingAccessCodeBenefit("org-1");
    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "access code pending benefit lookup failed",
      expect.objectContaining({
        event: "access_code.pending_benefit_lookup_failed",
        org_id: "org-1",
      })
    );
  });
});

describe("getPendingAccessCodeBenefitView", () => {
  it("returns null when there is no pending redemption", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await getPendingAccessCodeBenefitView("org-1");
    expect(result).toBeNull();
  });

  it("returns null for a gate-pass-only code (no trial, no coupon)", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: null, stripe_coupon_id: null, plan_slug: null },
      },
      error: null,
    });

    const result = await getPendingAccessCodeBenefitView("org-1");
    expect(result).toBeNull();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("composes a trial-only view without calling describeCoupon", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 30, stripe_coupon_id: null, plan_slug: "builder" },
      },
      error: null,
    });

    const result = await getPendingAccessCodeBenefitView("org-1");
    expect(result).toEqual({ trialDays: 30, planSlug: "builder", coupon: null });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("composes a coupon descriptor from describeCoupon", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: {
          trial_days: null,
          stripe_coupon_id: "coupon_abc",
          plan_slug: null,
        },
      },
      error: null,
    });
    mockRetrieve.mockResolvedValueOnce({
      percent_off: 50,
      amount_off: null,
      duration: "once",
      duration_in_months: null,
    });

    const result = await getPendingAccessCodeBenefitView("org-1");
    expect(mockRetrieve).toHaveBeenCalledWith("coupon_abc");
    expect(result).toEqual({
      trialDays: null,
      planSlug: null,
      coupon: { kind: "percent", percent: 50, duration: "once", months: null },
    });
  });

  it("falls back to null (not a crash) when the coupon lookup fails and there's no trial", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: {
          trial_days: null,
          stripe_coupon_id: "coupon_gone",
          plan_slug: null,
        },
      },
      error: null,
    });
    mockRetrieve.mockRejectedValueOnce(new Error("No such coupon"));

    const result = await getPendingAccessCodeBenefitView("org-1");
    expect(result).toBeNull();
  });

  it("still shows the trial when the coupon lookup fails but a trial exists", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: {
          trial_days: 14,
          stripe_coupon_id: "coupon_gone",
          plan_slug: null,
        },
      },
      error: null,
    });
    mockRetrieve.mockRejectedValueOnce(new Error("No such coupon"));

    const result = await getPendingAccessCodeBenefitView("org-1");
    expect(result).toEqual({ trialDays: 14, planSlug: null, coupon: null });
  });
});
