import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrder, mockMaybeSingle, mockGetUserById } = vi.hoisted(() => ({
  mockOrder: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  // Two chained .order() calls; the node resolves the rows via mockOrder().
  chain.order = () => chain;
  chain.maybeSingle = () => mockMaybeSingle();
  chain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
    Promise.resolve(mockOrder()).then(onF, onR);
  return {
    supabaseAdmin: {
      from: () => chain,
      auth: { admin: { getUserById: mockGetUserById } },
    },
  };
});

import { listUserOrgs, getOrgName, listOrgMembers } from "../members";

beforeEach(() => vi.clearAllMocks());

describe("listUserOrgs", () => {
  it("returns each org's id and name, oldest first", async () => {
    mockOrder.mockResolvedValue({
      data: [
        { org_id: "org-a", created_at: "1", organizations: { name: "Acme" } },
        { org_id: "org-b", created_at: "2", organizations: { name: "Beta" } },
      ],
    });
    expect(await listUserOrgs("user-1")).toEqual([
      { orgId: "org-a", name: "Acme" },
      { orgId: "org-b", name: "Beta" },
    ]);
  });

  it("normalizes an embedded relation returned as an array", async () => {
    mockOrder.mockResolvedValue({
      data: [{ org_id: "org-a", created_at: "1", organizations: [{ name: "Acme" }] }],
    });
    expect(await listUserOrgs("user-1")).toEqual([
      { orgId: "org-a", name: "Acme" },
    ]);
  });

  it("falls back to a placeholder name when the org name is missing", async () => {
    mockOrder.mockResolvedValue({
      data: [{ org_id: "org-a", created_at: "1", organizations: null }],
    });
    expect(await listUserOrgs("user-1")).toEqual([
      { orgId: "org-a", name: "Untitled team" },
    ]);
  });

  it("returns an empty list when the user has no memberships", async () => {
    mockOrder.mockResolvedValue({ data: [] });
    expect(await listUserOrgs("user-1")).toEqual([]);
  });

  it("returns an empty list when the query resolves with no data field at all", async () => {
    mockOrder.mockResolvedValue({ data: undefined, error: null });
    expect(await listUserOrgs("user-1")).toEqual([]);
  });

  it("throws when Supabase returns an error", async () => {
    const dbError = { message: "connection lost", code: "PGRST000" };
    mockOrder.mockResolvedValue({ data: null, error: dbError });
    await expect(listUserOrgs("user-1")).rejects.toBe(dbError);
  });
});

describe("getOrgName", () => {
  it("returns the org's name when found", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { name: "Acme" }, error: null });
    expect(await getOrgName("org-1", "fallback")).toBe("Acme");
  });

  it("returns the fallback when the row is absent (not an error)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getOrgName("org-1", "fallback")).toBe("fallback");
  });
});

describe("listOrgMembers", () => {
  it("resolves each member's email via the admin auth API and normalizes role", async () => {
    mockOrder.mockResolvedValue({
      data: [
        { user_id: "user-1", role: "admin", created_at: "1" },
        { user_id: "user-2", role: "member", created_at: "2" },
      ],
    });
    mockGetUserById.mockImplementation((id: string) =>
      Promise.resolve({ data: { user: { email: `${id}@acme.com` } } })
    );

    expect(await listOrgMembers("org-1")).toEqual([
      { userId: "user-1", email: "user-1@acme.com", role: "admin" },
      { userId: "user-2", email: "user-2@acme.com", role: "member" },
    ]);
  });

  it("normalizes any non-admin role string to 'member'", async () => {
    mockOrder.mockResolvedValue({
      data: [{ user_id: "user-1", role: "owner", created_at: "1" }],
    });
    mockGetUserById.mockResolvedValue({ data: { user: { email: "a@b.com" } } });

    expect(await listOrgMembers("org-1")).toEqual([
      { userId: "user-1", email: "a@b.com", role: "member" },
    ]);
  });

  it("falls back to a null email when the auth lookup rejects", async () => {
    mockOrder.mockResolvedValue({
      data: [{ user_id: "user-1", role: "admin", created_at: "1" }],
    });
    mockGetUserById.mockRejectedValue(new Error("transport failure"));

    expect(await listOrgMembers("org-1")).toEqual([
      { userId: "user-1", email: null, role: "admin" },
    ]);
  });

  it("falls back to a null email when the auth lookup resolves with no user", async () => {
    mockOrder.mockResolvedValue({
      data: [{ user_id: "user-1", role: "admin", created_at: "1" }],
    });
    mockGetUserById.mockResolvedValue({ data: { user: null } });

    expect(await listOrgMembers("org-1")).toEqual([
      { userId: "user-1", email: null, role: "admin" },
    ]);
  });

  it("returns an empty list when the org has no members", async () => {
    mockOrder.mockResolvedValue({ data: [] });
    expect(await listOrgMembers("org-1")).toEqual([]);
  });

  it("returns an empty list when the query resolves with no data field at all", async () => {
    mockOrder.mockResolvedValue({ data: undefined, error: null });
    expect(await listOrgMembers("org-1")).toEqual([]);
  });

  it("throws when the membership query errors", async () => {
    const dbError = { message: "boom" };
    mockOrder.mockResolvedValue({ data: null, error: dbError });
    await expect(listOrgMembers("org-1")).rejects.toBe(dbError);
  });
});
