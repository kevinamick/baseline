import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetAuthContext = vi.fn();
const mockGetProviderKeyRows = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
// The page is locale-aware (issue #245). Stub next-intl/server so the test
// doesn't need a request-scoped i18n config; `t` just echoes its key.
vi.mock("next-intl/server", () => {
  const t = (key: string) => key;
  t.rich = (key: string) => key;
  return {
    setRequestLocale: vi.fn(),
    getTranslations: vi.fn(async () => t),
  };
});
vi.mock("@/lib/auth/workspace", () => ({
  getWorkspaceName: vi.fn(async () => "Local Workspace"),
}));
vi.mock("@/lib/billing/state", () => ({
  getBillingState: vi.fn(async () => ({ plan: "free" })),
}));
vi.mock("@/lib/llm/keys", () => ({ getProviderKeyRows: mockGetProviderKeyRows }));
vi.mock("@/app/_components/provider-keys-list", () => ({ ProviderKeysList: () => null }));

describe("TeamSettingsPage (provider keys, ADR-0020)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderKeyRows.mockResolvedValue([]);
  });

  it("renders the Workspace's provider keys for its Contributor", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "admin", canWrite: true });
    const { default: Page } = await import("../page");
    const result = await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(result).not.toBeNull();
    expect(mockGetProviderKeyRows).toHaveBeenCalledWith("o");
  });
});
