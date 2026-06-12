import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockGetAuthContext,
  mockTrack,
  mockGetBillingState,
  mockUpsert,
  mockUpdateEq,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockTrack: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockUpsert: vi.fn(),
  mockUpdateEq: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
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

import { setOverageCap, clearOverageCap } from "../billing-overage";

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
  mockUpsert.mockResolvedValue({ error: null });
  mockUpdateEq.mockResolvedValue({ error: null });
});

describe("setOverageCap", () => {
  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "org_1", canWrite: false });
    expect(await setOverageCap(form("25"))).toEqual({
      error: "Only contributors can change billing settings",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Enter a dollar amount"],
    ["abc", "Enter a dollar amount"],
    ["0.50", "at least $1"],
    ["-5", "at least $1"],
    ["10.999", "more precise than cents"],
    ["10001", "can't exceed"],
  ])("rejects %s", async (raw, fragment) => {
    const result = await setOverageCap(form(raw));
    expect((result as { error: string }).error).toContain(fragment);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("requires an actively-paid plan with overage rates", async () => {
    mockGetBillingState.mockResolvedValue({ active: false, plan: "free" });
    expect(await setOverageCap(form("25"))).toEqual({
      error: "Overage is available on active paid plans only",
    });

    // past_due floors the plan to free → rates null → refused too.
    mockGetBillingState.mockResolvedValue({ active: true, plan: "free" });
    expect(await setOverageCap(form("25"))).toEqual({
      error: "Overage is available on active paid plans only",
    });
  });

  it("upserts the cap and tracks the opt-in", async () => {
    expect(await setOverageCap(form("25.50"))).toEqual({ ok: true });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org_1",
        overage_cap_usd: 25.5,
        updated_by: "user_1",
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.overage_cap_set",
        props: { team_id: "org_1", cap_usd: 25.5 },
      }),
      { userId: "user_1" }
    );
  });
});

describe("clearOverageCap", () => {
  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "org_1", canWrite: false });
    expect(await clearOverageCap()).toEqual({
      error: "Only contributors can change billing settings",
    });
  });

  it("clears without any plan gate — turning exposure OFF is never blocked", async () => {
    mockGetBillingState.mockResolvedValue({ active: false, plan: "free" });
    expect(await clearOverageCap()).toEqual({ ok: true });
    expect(mockGetBillingState).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.overage_cap_cleared" }),
      { userId: "user_1" }
    );
  });
});