import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const {
  mockGetAuthContext,
  mockOrgInsert,
  mockOrgSingle,
  mockMembershipInsert,
  mockOrgDeleteEq,
  mockTrack,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockOrgInsert: vi.fn(),
  mockOrgSingle: vi.fn(),
  mockMembershipInsert: vi.fn(),
  mockOrgDeleteEq: vi.fn(),
  mockTrack: vi.fn(),
  // Next's redirect() never returns — model it as a throw so control flow halts.
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "organizations") {
        return {
          insert: (...args: unknown[]) => {
            mockOrgInsert(...args);
            return { select: () => ({ single: mockOrgSingle }) };
          },
          delete: () => ({ eq: mockOrgDeleteEq }),
        };
      }
      return { insert: mockMembershipInsert };
    },
  },
}));

import { createOrganization } from "../orgs";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({ userId: "user-1", orgId: null });
  mockOrgSingle.mockResolvedValue({ data: { id: "org-1" }, error: null });
  mockMembershipInsert.mockResolvedValue({ error: null });
});

describe("createOrganization", () => {
  it("creates the org + owner membership and redirects to /rubrics", async () => {
    await expect(createOrganization({}, fd({ name: "Acme" }))).rejects.toThrow(
      "REDIRECT:/rubrics"
    );
    expect(mockMembershipInsert).toHaveBeenCalledWith({
      org_id: "org-1",
      user_id: "user-1",
      role: "admin",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "team.created", props: { team_id: "org-1" } },
      { userId: "user-1" }
    );
  });

  it("trims the submitted name", async () => {
    await expect(
      createOrganization({}, fd({ name: "  Acme  " }))
    ).rejects.toThrow("REDIRECT:/rubrics");
    expect(mockOrgInsert).toHaveBeenCalledWith({ name: "Acme" });
  });

  it("requires a sign-in", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null });
    const result = await createOrganization({}, fd({ name: "Acme" }));
    expect(result).toEqual({
      error: "You must be signed in to create a team.",
    });
    expect(mockOrgSingle).not.toHaveBeenCalled();
  });

  it("sends an already-onboarded user straight to /rubrics", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "user-1", orgId: "org-9" });
    await expect(createOrganization({}, fd({ name: "Acme" }))).rejects.toThrow(
      "REDIRECT:/rubrics"
    );
    expect(mockOrgSingle).not.toHaveBeenCalled();
  });

  it("requires a team name", async () => {
    const result = await createOrganization({}, fd({ name: "   " }));
    expect(result).toEqual({ error: "Team name is required." });
    expect(mockOrgSingle).not.toHaveBeenCalled();
  });

  it("rolls back the org when the membership insert fails", async () => {
    mockMembershipInsert.mockResolvedValue({ error: { message: "nope" } });
    mockOrgDeleteEq.mockResolvedValue({ error: null });
    const result = await createOrganization({}, fd({ name: "Acme" }));
    expect(result).toEqual({
      error: "Could not create your team. Please try again.",
    });
    expect(mockOrgDeleteEq).toHaveBeenCalledWith("id", "org-1");
  });
});
