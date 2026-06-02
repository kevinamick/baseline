import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));
// `server-only` throws if imported outside a server bundle; stub it for the test env.
vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAuthContext", () => {
  it("maps an org admin to a writable admin context", async () => {
    mockAuth.mockResolvedValue({ userId: "user_1", orgId: "org_1", orgRole: "org:admin" });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: "user_1",
      orgId: "org_1",
      role: "admin",
      canWrite: true,
    });
  });

  it("maps a non-admin org role to a read-only member context", async () => {
    mockAuth.mockResolvedValue({ userId: "user_1", orgId: "org_1", orgRole: "org:member" });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: "user_1",
      orgId: "org_1",
      role: "member",
      canWrite: false,
    });
  });

  it("normalizes missing userId/orgId/orgRole to nulls and read-only", async () => {
    mockAuth.mockResolvedValue({ userId: null, orgId: undefined, orgRole: null });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: null,
      orgId: null,
      role: "member",
      canWrite: false,
    });
  });
});
