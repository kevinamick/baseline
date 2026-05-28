import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedirect = vi.fn();
const mockAuth = vi.fn();

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));
// OrganizationProfile is a client component — stub it so the server render doesn't fail.
vi.mock("@clerk/nextjs", () => ({
  OrganizationProfile: vi.fn(() => null),
}));

describe("TeamSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects readonly members to /rubrics", async () => {
    mockAuth.mockResolvedValue({ orgRole: "org:member" });
    const { default: Page } = await import("../page");
    await Page();
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });

  it("renders for contributors without redirecting", async () => {
    mockAuth.mockResolvedValue({ orgRole: "org:admin" });
    const { default: Page } = await import("../page");
    const result = await Page();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("redirects when orgRole is null (no team membership)", async () => {
    mockAuth.mockResolvedValue({ orgRole: null });
    const { default: Page } = await import("../page");
    await Page();
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });
});
