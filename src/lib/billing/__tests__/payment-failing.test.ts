import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockMaybeSingle, mockGetBillingState } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockGetBillingState: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
    }),
  },
}));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/billing/limit-notifications", () => ({ notifyLimitOnce: vi.fn() }));

import { paymentMethodFailing } from "../managed-spend";

// `paymentMethodFailing` reads two signals: customers.managed_payment_failed_at
// (via isManagedPaymentBlocked) and the subscription status (via getBillingState).
function setSignals(opts: {
  managedFailedAt?: string | null;
  managedError?: boolean;
  status?: string | null;
}) {
  mockMaybeSingle.mockResolvedValue(
    opts.managedError
      ? { data: null, error: { message: "boom" } }
      : { data: { managed_payment_failed_at: opts.managedFailedAt ?? null }, error: null },
  );
  mockGetBillingState.mockResolvedValue({ plan: "builder", status: opts.status ?? "active" });
}

describe("paymentMethodFailing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is false when the card is healthy and the subscription is active", async () => {
    setSignals({ managedFailedAt: null, status: "active" });
    expect(await paymentMethodFailing("org")).toBe(false);
  });

  it("is false for a trialing subscription with no managed decline", async () => {
    setSignals({ managedFailedAt: null, status: "trialing" });
    expect(await paymentMethodFailing("org")).toBe(false);
  });

  // The case this gate actually changes: a managed-token decline while the paid
  // subscription is still active (so the plan isn't floored to Free).
  it("is true when managed_payment_failed_at is set on an active subscription", async () => {
    setSignals({ managedFailedAt: "2026-06-01T00:00:00Z", status: "active" });
    expect(await paymentMethodFailing("org")).toBe(true);
  });

  it("is true when the subscription is past_due", async () => {
    setSignals({ managedFailedAt: null, status: "past_due" });
    expect(await paymentMethodFailing("org")).toBe(true);
  });

  it("is true when the subscription is unpaid", async () => {
    setSignals({ managedFailedAt: null, status: "unpaid" });
    expect(await paymentMethodFailing("org")).toBe(true);
  });

  // Fails closed: an unreadable managed-payment mirror suppresses overage rather
  // than waving unpaid credit through (isManagedPaymentBlocked returns true on error).
  it("is true (fail-closed) when the managed-payment mirror can't be read", async () => {
    setSignals({ managedError: true, status: "active" });
    expect(await paymentMethodFailing("org")).toBe(true);
  });
});
