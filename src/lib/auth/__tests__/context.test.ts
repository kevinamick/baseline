import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEq = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));
// Membership lookup runs through the service-role admin client. Model the
// query builder as a chain whose terminal `maybeSingle()` resolves the row.
vi.mock("@/lib/supabase/admin", () => {
  const chain = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      mockEq(...args);
      return chain;
    },
    limit: () => chain,
    maybeSingle: mockMaybeSingle,
  };
  return { supabaseAdmin: { from: () => chain } };
});
// `server-only` throws if imported outside a server bundle; stub it for the test env.
vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  // getAuthContext is wrapped in React cache(); reset the module registry so
  // each test gets a fresh (un-memoized) instance.
  vi.resetModules();
});

describe("getAuthContext", () => {
  it("resolves the active org, admin role, and email from the owner membership", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "uuid-1", email: "owner@acme.com" } },
    });
    mockMaybeSingle.mockResolvedValue({
      data: { org_id: "org-uuid", role: "admin" },
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
    mockMaybeSingle.mockResolvedValue({
      data: { org_id: "org-uuid", role: "member" },
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

  it("returns a team-less context when the user has no membership", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "uuid-3" } } });
    mockMaybeSingle.mockResolvedValue({ data: null });
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
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });
});
