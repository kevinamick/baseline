import { describe, it, expect, vi } from "vitest";

// managed-invoice-sync is server-only and constructs the Stripe client at import;
// stub the heavy deps so the pure decision helper can be imported in node.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ stripe: {} }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/logging/server", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { shouldBillManagedPeriod } from "../managed-invoice-sync";

/**
 * Threshold-billing trigger logic (#186). Bill now when un-invoiced accrued
 * managed spend crosses the plan threshold (bounding extended credit) OR the
 * period has ended (month-end flush of any sub-threshold remainder).
 */
describe("shouldBillManagedPeriod", () => {
  const BUILDER_THRESHOLD = 10;

  it("does not bill while un-invoiced spend is below the threshold mid-period", () => {
    expect(shouldBillManagedPeriod(9.99, BUILDER_THRESHOLD, false)).toBe(false);
  });

  it("bills the moment un-invoiced spend reaches the threshold", () => {
    expect(shouldBillManagedPeriod(10, BUILDER_THRESHOLD, false)).toBe(true);
    expect(shouldBillManagedPeriod(12.5, BUILDER_THRESHOLD, false)).toBe(true);
  });

  it("flushes a sub-threshold remainder once the period has ended", () => {
    expect(shouldBillManagedPeriod(3.21, BUILDER_THRESHOLD, true)).toBe(true);
  });

  it("never bills a fully-invoiced (zero un-invoiced) period, even at period end", () => {
    expect(shouldBillManagedPeriod(0, BUILDER_THRESHOLD, true)).toBe(false);
    // Sub-cent float noise is not billable spend.
    expect(shouldBillManagedPeriod(1e-9, BUILDER_THRESHOLD, true)).toBe(false);
  });

  it("a plan with no threshold (BYO-only) only bills at period end", () => {
    expect(shouldBillManagedPeriod(50, null, false)).toBe(false);
    expect(shouldBillManagedPeriod(50, null, true)).toBe(true);
  });
});
