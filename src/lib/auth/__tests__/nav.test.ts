import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthContext, mockListUserOrgs, mockGetBillingState } = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockListUserOrgs: vi.fn(),
  mockGetBillingState: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/auth/members", () => ({ listUserOrgs: mockListUserOrgs }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

import { resolveNavAuth } from "../nav";

beforeEach(() => vi.clearAllMocks());

describe("resolveNavAuth", () => {
  it("resolves orgs, active org, email, write access, and plan for a member with a team", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      email: "owner@acme.com",
      orgId: "org-1",
      canWrite: true,
    });
    mockListUserOrgs.mockResolvedValue([{ orgId: "org-1", name: "Acme" }]);
    mockGetBillingState.mockResolvedValue({ plan: "builder" });

    const result = await resolveNavAuth();

    expect(result).toEqual({
      orgs: [{ orgId: "org-1", name: "Acme" }],
      activeOrgId: "org-1",
      email: "owner@acme.com",
      canManageTeam: true,
      plan: "builder",
    });
    expect(mockListUserOrgs).toHaveBeenCalledWith("user-1");
    expect(mockGetBillingState).toHaveBeenCalledWith("org-1");
  });

  it("skips the org lookup and returns an empty org list when there is no signed-in user", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: null,
      email: null,
      orgId: null,
      canWrite: false,
    });
    mockGetBillingState.mockResolvedValue({ plan: "free" });

    const result = await resolveNavAuth();

    expect(result).toEqual({
      orgs: [],
      activeOrgId: null,
      email: null,
      canManageTeam: false,
      plan: "free",
    });
    expect(mockListUserOrgs).not.toHaveBeenCalled();
    expect(mockGetBillingState).toHaveBeenCalledWith(null);
  });

  it("floors an unauthenticated/orgless plan to the billing state's default", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-2",
      email: "solo@acme.com",
      orgId: null,
      canWrite: false,
    });
    mockListUserOrgs.mockResolvedValue([]);
    mockGetBillingState.mockResolvedValue({ plan: "free" });

    const result = await resolveNavAuth();
    expect(result.plan).toBe("free");
    expect(result.orgs).toEqual([]);
  });
});
