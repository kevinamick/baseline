import { describe, it, expect, vi, beforeEach } from "vitest";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const {
  mockGetAuthContext,
  mockOrgInsert,
  mockOrgSingle,
  mockMembershipInsert,
  mockOrgDeleteEq,
  mockMembershipCount,
  mockTrack,
  mockRedirect,
  mockRevalidatePath,
  mockCookieSet,
  mockCookieDelete,
  mockBindFirstTeam,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockOrgInsert: vi.fn(),
  mockOrgSingle: vi.fn(),
  mockMembershipInsert: vi.fn(),
  mockOrgDeleteEq: vi.fn(),
  mockMembershipCount: vi.fn(),
  mockTrack: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCookieSet: vi.fn(),
  mockCookieDelete: vi.fn(),
  mockBindFirstTeam: vi.fn(),
  // Next's redirect() never returns — model it as a throw so control flow halts.
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
// First-Team Access Code binding (ADR-0017 slice 3, #427) is mocked here —
// its own guarded-update behavior is unit-tested directly in
// access-codes/__tests__/first-team-binding.test.ts.
vi.mock("@/lib/access-codes/first-team-binding", () => ({
  bindFirstTeamAccessCodeRedemption: mockBindFirstTeam,
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mockCookieSet, delete: mockCookieDelete })),
}));
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
      if (table === "memberships") {
        return {
          insert: mockMembershipInsert,
          // head-only count of the caller's remaining memberships
          select: () => ({ eq: mockMembershipCount }),
        };
      }
      return { insert: mockMembershipInsert };
    },
  },
}));

import { createOrganization, deleteOrganization } from "../orgs";

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
  mockOrgDeleteEq.mockResolvedValue({ error: null });
  mockMembershipCount.mockResolvedValue({ count: 0 });
  mockBindFirstTeam.mockResolvedValue(undefined);
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
    // The creator is switched into the org they just made.
    expect(mockCookieSet).toHaveBeenCalledWith(
      "active_org",
      "org-1",
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
    // First-Team Access Code binding (ADR-0017 slice 3, #427) runs for every
    // Team creation — bindFirstTeamAccessCodeRedemption's own guarded update
    // is what actually restricts this to the FIRST Team.
    expect(mockBindFirstTeam).toHaveBeenCalledWith("user-1", "org-1");
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

  it("lets a user who already has a team create another and switches into it", async () => {
    // #52: a user may own several orgs. Creating an additional team makes the
    // new org, not a no-op redirect, and sets it active.
    mockGetAuthContext.mockResolvedValue({ userId: "user-1", orgId: "org-9" });
    mockOrgSingle.mockResolvedValue({ data: { id: "org-2" }, error: null });
    await expect(createOrganization({}, fd({ name: "Beta" }))).rejects.toThrow(
      "REDIRECT:/rubrics"
    );
    expect(mockMembershipInsert).toHaveBeenCalledWith({
      org_id: "org-2",
      user_id: "user-1",
      role: "admin",
    });
    expect(mockCookieSet).toHaveBeenCalledWith(
      "active_org",
      "org-2",
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
    // Still called for a second Team — bindFirstTeamAccessCodeRedemption's
    // own guarded update (org_id IS NULL) is what makes this a no-op when a
    // redemption is already bound, not a branch here.
    expect(mockBindFirstTeam).toHaveBeenCalledWith("user-1", "org-2");
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

describe("deleteOrganization", () => {
  const admin = { userId: "user-1", orgId: "org-1", canWrite: true };

  it("deletes the active org, clears the cookie, and tracks it", async () => {
    mockGetAuthContext.mockResolvedValue(admin);
    mockMembershipCount.mockResolvedValue({ count: 0 });

    await expect(deleteOrganization()).rejects.toThrow("REDIRECT:/onboarding");

    expect(mockOrgDeleteEq).toHaveBeenCalledWith("id", "org-1");
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "team.deleted", props: { team_id: "org-1" } },
      { userId: "user-1" }
    );
    expect(mockCookieDelete).toHaveBeenCalledWith("active_org");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("routes to /rubrics when the user still belongs to another team", async () => {
    mockGetAuthContext.mockResolvedValue(admin);
    mockMembershipCount.mockResolvedValue({ count: 1 });

    await expect(deleteOrganization()).rejects.toThrow("REDIRECT:/rubrics");
  });

  it("routes to /onboarding when no teams remain", async () => {
    mockGetAuthContext.mockResolvedValue(admin);
    mockMembershipCount.mockResolvedValue({ count: 0 });

    await expect(deleteOrganization()).rejects.toThrow("REDIRECT:/onboarding");
  });

  it("falls through to /rubrics when the count query errors (null)", async () => {
    // A transient count failure must not strand a user who still has teams on
    // onboarding; the rubrics guard re-routes them if they're genuinely orgless.
    mockGetAuthContext.mockResolvedValue(admin);
    mockMembershipCount.mockResolvedValue({ count: null });

    await expect(deleteOrganization()).rejects.toThrow("REDIRECT:/rubrics");
  });

  it("refuses read-only members (not admin)", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      canWrite: false,
    });

    await deleteOrganization();

    expect(mockOrgDeleteEq).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does nothing when there is no active org", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      orgId: null,
      canWrite: true,
    });

    await deleteOrganization();

    expect(mockOrgDeleteEq).not.toHaveBeenCalled();
  });

  it("bails out without redirecting when the delete errors", async () => {
    mockGetAuthContext.mockResolvedValue(admin);
    mockOrgDeleteEq.mockResolvedValue({ error: { message: "nope" } });

    await deleteOrganization();

    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockCookieDelete).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
