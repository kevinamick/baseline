import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetBillingState, mockIsEndedStatus } = vi.hoisted(() => ({
  mockGetBillingState: vi.fn(),
  mockIsEndedStatus: vi.fn(),
}));

vi.mock("@/lib/billing/state", () => ({
  getBillingState: mockGetBillingState,
  isEndedStatus: mockIsEndedStatus,
}));

import { countMembers, seatCapError, getSeatCapState } from "../seats";

beforeEach(() => vi.clearAllMocks());

describe("countMembers (Local Workspace, ADR-0020)", () => {
  it("is always the one Contributor", async () => {
    expect(await countMembers("org_1")).toBe(1);
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
  it("is never violated: one Contributor always fits the Free cap, even after an ended subscription", async () => {
    mockGetBillingState.mockResolvedValue({ status: "canceled", plan: "free" });
    mockIsEndedStatus.mockReturnValue(true);
    const state = await getSeatCapState("org_1");
    expect(state).toEqual({ violated: false, memberCount: 1, seatLimit: 1 });
  });

  it("reports an unlimited seat limit on a paid plan", async () => {
    mockGetBillingState.mockResolvedValue({ status: "active", plan: "builder" });
    mockIsEndedStatus.mockReturnValue(false);
    const state = await getSeatCapState("org_1");
    expect(state).toEqual({ violated: false, memberCount: 1, seatLimit: null });
  });
});
