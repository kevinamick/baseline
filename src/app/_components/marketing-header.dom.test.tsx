// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Locale-aware Link → plain anchor so assertions stay on href + label.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// Resolve the shared Nav copy against the real English catalog.
vi.mock("next-intl/server", () => ({
  getTranslations: async (ns: string) => {
    const en = (await import("../../../messages/en.json"))
      .default as unknown as Record<string, Record<string, string>>;
    return (key: string) => en[ns]?.[key] ?? key;
  },
}));
// BrandMark renders next/image; swap for a plain img in jsdom.
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

const mockGetAuthContext = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getAuthContext: () => mockGetAuthContext(),
}));

import { MarketingHeader } from "./marketing-header";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MarketingHeader — auth-aware CTA", () => {
  it("shows Get started free → /sign-up for a signed-out visitor", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null });

    render(await MarketingHeader());

    const cta = screen.getByRole("link", { name: "Get started free" });
    expect(cta).toHaveAttribute("href", "/sign-up");
    expect(
      screen.queryByRole("link", { name: "Open Baseline" })
    ).not.toBeInTheDocument();
  });

  it("shows Open Baseline → /dashboard for a signed-in user", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "user-1" });

    render(await MarketingHeader());

    const cta = screen.getByRole("link", { name: "Open Baseline" });
    expect(cta).toHaveAttribute("href", "/dashboard");
    expect(
      screen.queryByRole("link", { name: "Get started free" })
    ).not.toBeInTheDocument();
  });

  it("falls back to the signed-out CTA when the auth read throws (public page must not 500)", async () => {
    // getAuthContext resolves the memberships table and throws on a read error;
    // a public SEO page must degrade to "Get started free", not a 500.
    mockGetAuthContext.mockRejectedValue(new Error("memberships read failed"));

    render(await MarketingHeader());

    expect(
      screen.getByRole("link", { name: "Get started free" })
    ).toHaveAttribute("href", "/sign-up");
    expect(
      screen.queryByRole("link", { name: "Open Baseline" })
    ).not.toBeInTheDocument();
  });

  it("always offers the Pricing link and the Baseline wordmark home link", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null });

    render(await MarketingHeader());

    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute(
      "href",
      "/pricing"
    );
    expect(screen.getByRole("link", { name: "Baseline" })).toHaveAttribute(
      "href",
      "/"
    );
  });
});
