import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedirect = vi.fn();
const mockGetAuthContext = vi.fn();

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
// This test exercises the page's authz/redirect logic; stub the modules that
// pull in the service-role client (`server-only`) so they aren't loaded here.
vi.mock("@/app/_components/nav-bar", () => ({ NavBar: () => null }));
vi.mock("@/app/settings/team/_components/invite-member-form", () => ({
  InviteMemberForm: () => null,
}));
vi.mock("@/app/actions/invitations", () => ({ revokeInvitation: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => Promise.resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));

describe("TeamSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects readonly members to /rubrics", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "member", canWrite: false });
    const { default: Page } = await import("../page");
    await Page();
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });

  it("renders for contributors without redirecting", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "admin", canWrite: true });
    const { default: Page } = await import("../page");
    const result = await Page();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("redirects when there is no team membership (cannot write)", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: null, role: "member", canWrite: false });
    const { default: Page } = await import("../page");
    await Page();
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });
});
