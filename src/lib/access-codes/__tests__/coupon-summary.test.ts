import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockRetrieve, mockLogError } = vi.hoisted(() => ({
  mockRetrieve: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: { coupons: { retrieve: mockRetrieve } },
}));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

import {
  describeCoupon,
  couponBenefitDescriptor,
  couponBenefitMessageKey,
} from "../coupon-summary";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("describeCoupon", () => {
  it("reads a percent-off coupon's display shape", async () => {
    mockRetrieve.mockResolvedValueOnce({
      percent_off: 50,
      amount_off: null,
      duration: "repeating",
      duration_in_months: 3,
    });

    const result = await describeCoupon("coupon_abc");
    expect(result).toEqual({
      percentOff: 50,
      amountOffUsd: null,
      duration: "repeating",
      durationInMonths: 3,
    });
  });

  it("converts amount_off from cents to dollars", async () => {
    mockRetrieve.mockResolvedValueOnce({
      percent_off: null,
      amount_off: 2500,
      duration: "once",
      duration_in_months: null,
    });

    const result = await describeCoupon("coupon_abc");
    expect(result).toEqual({
      percentOff: null,
      amountOffUsd: 25,
      duration: "once",
      durationInMonths: null,
    });
  });

  it("fails closed and logs when the Stripe lookup errors", async () => {
    mockRetrieve.mockRejectedValueOnce(new Error("No such coupon"));

    const result = await describeCoupon("coupon_gone");
    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "access code coupon lookup failed",
      expect.objectContaining({
        event: "access_code.coupon_lookup_failed",
        stripe_coupon_id: "coupon_gone",
      })
    );
  });
});

describe("couponBenefitDescriptor", () => {
  it("prefers percent_off when both are somehow set", () => {
    const descriptor = couponBenefitDescriptor({
      percentOff: 50,
      amountOffUsd: 10,
      duration: "once",
      durationInMonths: null,
    });
    expect(descriptor).toEqual({
      kind: "percent",
      percent: 50,
      duration: "once",
      months: null,
    });
  });

  it("falls back to amount_off when percent_off is null", () => {
    const descriptor = couponBenefitDescriptor({
      percentOff: null,
      amountOffUsd: 10,
      duration: "forever",
      durationInMonths: null,
    });
    expect(descriptor).toEqual({
      kind: "amount",
      amountUsd: 10,
      duration: "forever",
      months: null,
    });
  });

  it("returns null when the coupon has neither", () => {
    const descriptor = couponBenefitDescriptor({
      percentOff: null,
      amountOffUsd: null,
      duration: "once",
      durationInMonths: null,
    });
    expect(descriptor).toBeNull();
  });
});

describe("couponBenefitMessageKey", () => {
  it.each([
    ["percent", "once", "pendingBenefitCouponPercentOnce"],
    ["percent", "repeating", "pendingBenefitCouponPercentRepeating"],
    ["percent", "forever", "pendingBenefitCouponPercentForever"],
    ["amount", "once", "pendingBenefitCouponAmountOnce"],
    ["amount", "repeating", "pendingBenefitCouponAmountRepeating"],
    ["amount", "forever", "pendingBenefitCouponAmountForever"],
  ] as const)("%s + %s -> %s", (kind, duration, expected) => {
    const descriptor =
      kind === "percent"
        ? ({ kind, percent: 10, duration, months: 3 } as const)
        : ({ kind, amountUsd: 10, duration, months: 3 } as const);
    expect(couponBenefitMessageKey(descriptor)).toBe(expected);
  });
});
