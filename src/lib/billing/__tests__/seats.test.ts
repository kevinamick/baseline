import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockHeadCount, mockGetBillingState, mockIsEndedStatus } = vi.hoisted(() => ({
  mockHeadCount: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockIsEndedStatus: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: mockHeadCount }),
    }),
  },
}));
vi.mock("@/lib/billing/state", () => ({
  getBillingState: mockGetBillingState,
  isEndedStatus: mockIsEndedStatus,
}));

import { countMembers, seatCapError, getSeatCapState } from "../seats";

beforeEach(() => vi.clearAllMocks());

describe("countMembers", () => {
  it("returns the head count", async () => {
    mockHeadCount.mockResolvedValue({ count: 3, error: null });
    expect(await countMembers("org_1")).toBe(3);
  });

  it("treats a null count as zero", async () => {
    mockHeadCount.mockResolvedValue({ count: null, error: null });
    expect(await countMembers("org_1")).toBe(0);
  });

  it("throws on a read error", async () => {
    mockHeadCount.mockResolvedValue({ count: null, error: new Error("db down") });
    await expect(countMembers("org_1")).rejects.toThrow("db down");
  });
});

describe("seatCapError", () => {
  it("names the member count, the limit, and the requested action", () => {
    expect(seatCapError({ violated: true, memberCount: 5, seatLimit: 1 }, "invite")).toBe(
      "Your team has 5 members but the current plan includes 1 — remove members or upgrade to invite."
    );
  });
});

describe("getSeatCapState", () => {
  it("is violated only when the subscription ended AND membership exceeds a finite cap", async () => {
    mockGetBillingState.mockResolvedValue({ status: "canceled", plan: "free" });
    mockIsEndedStatus.mockReturnValue(true);
    mockHeadCount.mockResolvedValue({ count: 2, error: null });
    const state = await getSeatCapState("org_1");
    expect(state).toEqual({ violated: true, memberCount: 2, seatLimit: 1 });
  });

  it("is not violated when the subscription is merely in payment trouble (not ended)", async () => {
    mockGetBillingState.mockResolvedValue({ status: "past_due", plan: "free" });
    mockIsEndedStatus.mockReturnValue(false);
    mockHeadCount.mockResolvedValue({ count: 5, error: null });
    const state = await getSeatCapState("org_1");
    expect(state.violated).toBe(false);
  });

  it("is never violated on an unlimited-seat plan", async () => {
    mockGetBillingState.mockResolvedValue({ status: "canceled", plan: "builder" });
    mockIsEndedStatus.mockReturnValue(true);
    mockHeadCount.mockResolvedValue({ count: 50, error: null });
    const state = await getSeatCapState("org_1");
    expect(state).toEqual({ violated: false, memberCount: 50, seatLimit: null });
  });

  it("is not violated when membership is within the cap", async () => {
    mockGetBillingState.mockResolvedValue({ status: "canceled", plan: "free" });
    mockIsEndedStatus.mockReturnValue(true);
    mockHeadCount.mockResolvedValue({ count: 1, error: null });
    const state = await getSeatCapState("org_1");
    expect(state.violated).toBe(false);
  });
});
