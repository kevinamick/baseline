import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthContext, mockGetWorkspaceName, mockGetBillingState } = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockGetWorkspaceName: vi.fn(),
  mockGetBillingState: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/auth/workspace", () => ({ getWorkspaceName: mockGetWorkspaceName }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

import { resolveNavAuth } from "../nav";

beforeEach(() => vi.clearAllMocks());

describe("resolveNavAuth", () => {
  it("resolves the Workspace name and plan for the nav", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "user-1", orgId: "org-1", canWrite: true });
    mockGetWorkspaceName.mockResolvedValue("Local Workspace");
    mockGetBillingState.mockResolvedValue({ plan: "builder" });

    const result = await resolveNavAuth();

    expect(result).toEqual({ workspaceName: "Local Workspace", plan: "builder" });
    expect(mockGetWorkspaceName).toHaveBeenCalledWith("org-1");
    expect(mockGetBillingState).toHaveBeenCalledWith("org-1");
  });
});
