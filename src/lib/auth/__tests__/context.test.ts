import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));
// `server-only` throws if imported outside a server bundle; stub it for the test env.
vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAuthContext", () => {
  it("returns the Supabase user id, with org/role stubbed until the orgs slice (#47)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "uuid-1" } } });
    const { getAuthContext } = await import("../context");
    expect(await getAuthContext()).toEqual({
      userId: "uuid-1",
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
      orgId: null,
      role: "member",
      canWrite: false,
    });
  });
});
