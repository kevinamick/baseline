import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetLogContext = vi.fn();
vi.mock("@/lib/logging/request-context", () => ({ setLogContext: mockSetLogContext }));
// `server-only` throws if imported outside a server bundle; stub it for the test env.
vi.mock("server-only", () => ({}));

import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/lib/auth/local-workspace";

beforeEach(() => {
  vi.clearAllMocks();
  // getAuthContext is wrapped in React cache(); reset the module registry so
  // each test gets a fresh (un-memoized) instance.
  vi.resetModules();
});

describe("getAuthContext (Local Workspace, ADR-0020)", () => {
  it("resolves the Local Workspace and its Contributor with write access, no session involved", async () => {
    const { getAuthContext } = await import("../context");
    const ctx = await getAuthContext();

    expect(ctx).toEqual({
      userId: LOCAL_USER_ID,
      email: null,
      orgId: LOCAL_WORKSPACE_ID,
      role: "admin",
      canWrite: true,
    });
  });

  it("seeds the per-request log context with the Workspace ids (#38)", async () => {
    const { getAuthContext } = await import("../context");
    await getAuthContext();

    expect(mockSetLogContext).toHaveBeenCalledWith({
      user_id: LOCAL_USER_ID,
      org_id: LOCAL_WORKSPACE_ID,
    });
  });
});
