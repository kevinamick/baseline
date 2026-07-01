import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedirect = vi.fn();
const mockGetAuthContext = vi.fn();
const mockOrder = vi.fn(
  async (): Promise<{ data: unknown[] | null; error: unknown }> => ({
    data: [],
    error: null,
  })
);

// The logging/analytics modules have `import "server-only"`, which throws
// outside a server bundle.
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
// Echo i18n keys so the render doesn't need a request-scoped config.
vi.mock("next-intl/server", () => {
  const t = (key: string) => key;
  t.rich = (key: string) => key;
  return {
    setRequestLocale: vi.fn(),
    getTranslations: vi.fn(async () => t),
  };
});
// Client components pull in server actions / next-intl navigation; stub them so
// this page's redirect/render logic stays self-contained.
vi.mock("@/i18n/navigation", () => ({ Link: () => null }));
vi.mock("@/app/_components/brand-mark", () => ({ BrandMark: () => null }));
vi.mock("../_components/create-team-form", () => ({ CreateTeamForm: () => null }));
vi.mock("@/app/_components/accept-invite-button", () => ({
  AcceptInviteButton: () => null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        gt: () => chain,
        order: mockOrder,
      };
      return chain;
    },
  },
}));

describe("OnboardingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrder.mockResolvedValue({ data: [], error: null });
  });

  it("redirects a user who already has a Team to /rubrics", async () => {
    mockGetAuthContext.mockResolvedValue({
      email: "a@b.co",
      orgId: "org-1",
      canWrite: true,
    });
    const { default: Page } = await import("../page");
    await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });

  it("renders the create-team form for a user with no Team", async () => {
    mockGetAuthContext.mockResolvedValue({
      email: "a@b.co",
      orgId: null,
      canWrite: true,
    });
    const { default: Page } = await import("../page");
    const result = await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("surfaces pending invitations for a no-Team invitee", async () => {
    mockGetAuthContext.mockResolvedValue({
      email: "invitee@b.co",
      orgId: null,
      canWrite: true,
    });
    mockOrder.mockResolvedValue({
      data: [
        {
          id: "inv-1",
          expires_at: "2999-01-01T00:00:00Z",
          organizations: { name: "Acme" },
        },
      ],
      error: null,
    });
    const { default: Page } = await import("../page");
    const result = await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});
