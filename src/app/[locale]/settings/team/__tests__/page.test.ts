import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedirect = vi.fn();
const mockGetAuthContext = vi.fn();

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
// The page is now locale-aware (issue #245). Stub next-intl/server so the authz
// test doesn't need a request-scoped i18n config; `t` just echoes its key.
vi.mock("next-intl/server", () => {
  const t = (key: string) => key;
  t.rich = (key: string) => key;
  return {
    setRequestLocale: vi.fn(),
    getTranslations: vi.fn(async () => t),
  };
});
// This test exercises the page's authz/redirect logic; stub the modules that
// pull in the service-role client (`server-only`) so they aren't loaded here.
vi.mock("@/app/_components/nav-bar", () => ({ NavBar: () => null }));
vi.mock("@/app/[locale]/settings/team/_components/invite-member-form", () => ({
  InviteMemberForm: () => null,
}));
vi.mock("@/app/actions/invitations", () => ({ revokeInvitation: vi.fn() }));
vi.mock("@/app/actions/memberships", () => ({
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));
// DeleteTeamButton (a client component) imports this server-action module, which
// pulls in next/headers; stub it so the page's authz test stays self-contained.
vi.mock("@/app/actions/orgs", () => ({ deleteOrganization: vi.fn() }));
vi.mock("@/lib/auth/members", () => ({
  listOrgMembers: vi.fn(async () => []),
  getOrgName: vi.fn(async () => "Acme Inc"),
}));
// Provider keys section (#184): stub the server reads + the client list so the
// authz test stays self-contained.
vi.mock("@/lib/billing/state", () => ({
  getBillingState: vi.fn(async () => ({ plan: "free" })),
}));
vi.mock("@/lib/llm/keys", () => ({ getProviderKeyRows: vi.fn(async () => []) }));
vi.mock("@/app/_components/provider-keys-list", () => ({ ProviderKeysList: () => null }));
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
    await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });

  it("renders for contributors without redirecting", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "admin", canWrite: true });
    const { default: Page } = await import("../page");
    const result = await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("redirects when there is no team membership (cannot write)", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: null, role: "member", canWrite: false });
    const { default: Page } = await import("../page");
    await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });
});
