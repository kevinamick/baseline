import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthContext, mockGetWorkspaceName } = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockGetWorkspaceName: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/auth/workspace", () => ({ getWorkspaceName: mockGetWorkspaceName }));

import { resolveNavAuth } from "../nav";

beforeEach(() => vi.clearAllMocks());

describe("resolveNavAuth", () => {
  it("resolves the Workspace name for the nav", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "user-1", orgId: "org-1", canWrite: true });
    mockGetWorkspaceName.mockResolvedValue("Local Workspace");

    const result = await resolveNavAuth();

    expect(result).toEqual({ workspaceName: "Local Workspace" });
    expect(mockGetWorkspaceName).toHaveBeenCalledWith("org-1");
  });
});
