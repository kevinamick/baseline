import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrder } = vi.hoisted(() => ({ mockOrder: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = mockOrder;
  return { supabaseAdmin: { from: () => chain } };
});

import { listUserOrgs } from "../members";

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
});
