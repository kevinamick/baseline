import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMaybeSingle } = vi.hoisted(() => ({ mockMaybeSingle: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = () => mockMaybeSingle();
  return { supabaseAdmin: { from: () => chain } };
});

import { isTeamAdmin } from "../teams";

beforeEach(() => vi.clearAllMocks());

describe("isTeamAdmin", () => {
  it("returns false immediately when orgId is empty, without querying", async () => {
    expect(await isTeamAdmin("", "user-1")).toBe(false);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns false immediately when userId is empty, without querying", async () => {
    expect(await isTeamAdmin("org-1", "")).toBe(false);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns true for an admin membership", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { role: "admin" }, error: null });
    expect(await isTeamAdmin("org-1", "user-1")).toBe(true);
  });

  it("returns false for a member (non-admin) role", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { role: "member" }, error: null });
    expect(await isTeamAdmin("org-1", "user-1")).toBe(false);
  });

  it("returns false when no membership row exists", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await isTeamAdmin("org-1", "user-1")).toBe(false);
  });

  it("throws when the query errors", async () => {
    const dbError = { message: "boom" };
    mockMaybeSingle.mockResolvedValue({ data: null, error: dbError });
    await expect(isTeamAdmin("org-1", "user-1")).rejects.toBe(dbError);
  });
});
