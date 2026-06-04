import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
const mockOrder = vi.fn();
const mockEq = vi.fn();
const mockCookieGet = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));
// Membership lookup runs through the service-role admin client. Model the
// query builder as a chain whose terminal `order()` resolves the membership list.
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      mockEq(...args);
      return chain;
    },
    // Two chained .order() calls (created_at, then org_id); the node is
    // awaitable and resolves the membership list via mockOrder().
    order: () => chain,
    then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      Promise.resolve(mockOrder()).then(onF, onR),
  };
  return { supabaseAdmin: { from: () => chain } };
});
// The active-org cookie selects among the user's memberships.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockCookieGet })),
}));
// `server-only` throws if imported outside a server bundle; stub it for the test env.
vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no active-org cookie set.
  mockCookieGet.mockReturnValue(undefined);
  // getAuthContext is wrapped in React cache(); reset the module registry so
  // each test gets a fresh (un-memoized) instance.
  vi.resetModules();
});

describe("getAuthContext", () => {
  it("resolves the active org, admin role, and email from the owner membership", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "uuid-1", email: "owner@acme.com" } },
    });
    mockOrder.mockResolvedValue({
      data: [{ org_id: "org-uuid", role: "admin" }],
    });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: "uuid-1",
      email: "owner@acme.com",
      orgId: "org-uuid",
      role: "admin",
      canWrite: true,
    });
    expect(mockEq).toHaveBeenCalledWith("user_id", "uuid-1");
  });

  it("treats a read-only member as non-writing", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "uuid-2", email: "member@acme.com" } },
    });
    mockOrder.mockResolvedValue({
      data: [{ org_id: "org-uuid", role: "member" }],
    });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: "uuid-2",
      email: "member@acme.com",
      orgId: "org-uuid",
      role: "member",
      canWrite: false,
    });
  });

  it("picks the org named by the active_org cookie", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "uuid-4", email: "multi@acme.com" } },
    });
    mockOrder.mockResolvedValue({
      data: [
        { org_id: "org-a", role: "admin" },
        { org_id: "org-b", role: "member" },
      ],
    });
    mockCookieGet.mockReturnValue({ value: "org-b" });
    const { getAuthContext } = await import("../context");
    const ctx = await getAuthContext();
    expect(ctx.orgId).toBe("org-b");
    expect(ctx.role).toBe("member");
    expect(ctx.canWrite).toBe(false);
  });

  it("falls back to the oldest membership when no cookie is set", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "uuid-5", email: "multi@acme.com" } },
    });
    mockOrder.mockResolvedValue({
      data: [
        { org_id: "org-a", role: "admin" },
        { org_id: "org-b", role: "member" },
      ],
    });
    const { getAuthContext } = await import("../context");
    expect((await getAuthContext()).orgId).toBe("org-a");
  });

  it("ignores a forged cookie naming an org the user isn't in", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "uuid-6", email: "multi@acme.com" } },
    });
    mockOrder.mockResolvedValue({
      data: [
        { org_id: "org-a", role: "admin" },
        { org_id: "org-b", role: "member" },
      ],
    });
    mockCookieGet.mockReturnValue({ value: "org-they-dont-belong-to" });
    const { getAuthContext } = await import("../context");
    // Falls back to the oldest membership; the forged org grants nothing.
    expect((await getAuthContext()).orgId).toBe("org-a");
  });

  it("returns a team-less context when the user has no membership", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "uuid-3" } } });
    mockOrder.mockResolvedValue({ data: [] });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: "uuid-3",
      email: null,
      orgId: null,
      role: "member",
      canWrite: false,
    });
  });

  it("normalizes a missing session to a null user and read-only context", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: null,
      email: null,
      orgId: null,
      role: "member",
      canWrite: false,
    });
    // No session → no membership lookup.
    expect(mockOrder).not.toHaveBeenCalled();
  });
});
