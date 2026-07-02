import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockGetAuthContext,
  mockTrack,
  mockGetBillingState,
  mockGetTrustStatus,
  mockUpsert,
  mockUpdateEq,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockTrack: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockGetTrustStatus: vi.fn(),
  mockUpsert: vi.fn(),
  mockUpdateEq: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/billing/trust", () => ({ getTrustStatus: mockGetTrustStatus }));
vi.mock("@/lib/logging/server", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: mockUpsert,
      update: () => ({ eq: mockUpdateEq }),
    }),
  },
}));

import { setManagedSpendCap, resetManagedSpendCap } from "../billing-managed-spend";

function form(capUsd: string) {
  const f = new FormData();
  f.set("capUsd", capUsd);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    userId: "user_1",
    orgId: "org_1",
    canWrite: true,
  });
  mockGetBillingState.mockResolvedValue({ active: true, plan: "builder" });
  mockGetTrustStatus.mockResolvedValue({
    ceilingUsd: 50,
    paidInvoices: 0,
    nextTier: null,
  });
  mockUpsert.mockResolvedValue({ error: null });
  mockUpdateEq.mockResolvedValue({ error: null });
});

describe("setManagedSpendCap", () => {
  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "org_1", canWrite: false });
    expect(await setManagedSpendCap(form("25"))).toEqual({
      error: "Only contributors can change billing settings",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, canWrite: false });
    expect(await setManagedSpendCap(form("25"))).toEqual({ error: "Not signed in" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Enter a dollar amount"],
    ["abc", "Enter a dollar amount"],
    ["0.50", "at least $1"],
    ["-5", "at least $1"],
    ["10.999", "more precise than cents"],
  ])("rejects %s", async (raw, fragment) => {
    const result = await setManagedSpendCap(form(raw));
    expect((result as { error: string }).error).toContain(fragment);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("requires an active plan with managed spend (managedMarkupPct set)", async () => {
    mockGetBillingState.mockResolvedValue({ active: false, plan: "free" });
    expect(await setManagedSpendCap(form("25"))).toEqual({
      error: "Managed spend applies to active paid plans only",
    });

    // Free floors managedMarkupPct to null even when "active" — refused too.
    mockGetBillingState.mockResolvedValue({ active: true, plan: "free" });
    expect(await setManagedSpendCap(form("25"))).toEqual({
      error: "Managed spend applies to active paid plans only",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a raise above the trust ceiling, with copy on how to raise it", async () => {
    mockGetTrustStatus.mockResolvedValue({
      ceilingUsd: 25,
      paidInvoices: 1,
      nextTier: { atPaidInvoices: 3, ceilingUsd: 100 },
    });
    const result = await setManagedSpendCap(form("50"));
    expect((result as { error: string }).error).toContain("$25.00");
    expect((result as { error: string }).error).toContain("2 more invoices");
    expect((result as { error: string }).error).toContain("$100.00");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a raise above the ceiling with no further-tier copy when there is no next tier", async () => {
    mockGetTrustStatus.mockResolvedValue({ ceilingUsd: 25, paidInvoices: 5, nextTier: null });
    const result = await setManagedSpendCap(form("50"));
    expect((result as { error: string }).error).toContain("$25.00");
    expect((result as { error: string }).error).not.toContain("Pay");
  });

  it("singularizes 'invoice' when exactly one more is needed", async () => {
    mockGetTrustStatus.mockResolvedValue({
      ceilingUsd: 25,
      paidInvoices: 2,
      nextTier: { atPaidInvoices: 3, ceilingUsd: 100 },
    });
    const result = await setManagedSpendCap(form("50"));
    expect((result as { error: string }).error).toContain("1 more invoice ");
    expect((result as { error: string }).error).not.toContain("1 more invoices");
  });

  it("allows a raise at or below the trust ceiling", async () => {
    mockGetTrustStatus.mockResolvedValue({ ceilingUsd: 50, paidInvoices: 1, nextTier: null });
    expect(await setManagedSpendCap(form("50"))).toEqual({ ok: true });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org_1",
        managed_spend_cap_usd: 50,
        updated_by: "user_1",
      })
    );
  });

  it("allows lowering the cap regardless of the ceiling", async () => {
    mockGetTrustStatus.mockResolvedValue({ ceilingUsd: 10, paidInvoices: 0, nextTier: null });
    expect(await setManagedSpendCap(form("5"))).toEqual({ ok: true });
  });

  it("proceeds when the ceiling is null (unbounded)", async () => {
    mockGetTrustStatus.mockResolvedValue({ ceilingUsd: null, paidInvoices: 0, nextTier: null });
    expect(await setManagedSpendCap(form("999"))).toEqual({ ok: true });
  });

  it("upserts the cap and tracks the change", async () => {
    expect(await setManagedSpendCap(form("25.50"))).toEqual({ ok: true });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org_1",
        managed_spend_cap_usd: 25.5,
        updated_by: "user_1",
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.managed_spend_cap_set",
        props: { team_id: "org_1", cap_usd: 25.5 },
      }),
      { userId: "user_1" }
    );
  });

  it("returns an error when the upsert fails", async () => {
    mockUpsert.mockResolvedValue({ error: { message: "db down" } });
    expect(await setManagedSpendCap(form("25"))).toEqual({
      error: "Couldn't save the cap. Please try again.",
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe("resetManagedSpendCap", () => {
  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "org_1", canWrite: false });
    expect(await resetManagedSpendCap()).toEqual({
      error: "Only contributors can change billing settings",
    });
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, canWrite: false });
    expect(await resetManagedSpendCap()).toEqual({ error: "Not signed in" });
  });

  it("clears the override and tracks it", async () => {
    expect(await resetManagedSpendCap()).toEqual({ ok: true });
    expect(mockUpdateEq).toHaveBeenCalledWith("org_id", "org_1");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.managed_spend_cap_cleared" }),
      { userId: "user_1" }
    );
  });

  it("returns an error when the reset fails", async () => {
    mockUpdateEq.mockResolvedValue({ error: { message: "db down" } });
    expect(await resetManagedSpendCap()).toEqual({
      error: "Couldn't reset the cap. Please try again.",
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
