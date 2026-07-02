// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// site-footer.tsx pulls in next-intl + the locale-aware Link + CookiePreferencesButton
// (which itself pulls in cookie-consent.tsx). Mock the same seams
// cookie-preferences-button.dom.test.tsx / cookie-consent.dom.test.tsx use so this test
// doesn't need the full App Router runtime.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json"))
    .default as unknown as Record<string, Record<string, string>>;
  const useTranslations = (ns: string) => {
    const dict = en[ns] ?? {};
    const t = (key: string, values?: Record<string, unknown>) => {
      let s = dict[key] ?? key;
      if (values)
        for (const [k, v] of Object.entries(values))
          s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    return t;
  };
  return { useTranslations };
});

import { SiteFooter, SiteFooterLinks } from "./site-footer";

describe("SiteFooter", () => {
  it("renders a footer landmark with the copyright, privacy link, and cookie preferences", () => {
    render(<SiteFooter />);

    const footer = screen.getByRole("contentinfo");
    const year = new Date().getFullYear();
    expect(footer).toHaveTextContent(String(year));

    const privacyLink = screen.getByRole("link", { name: "Privacy & Cookie Notice" });
    expect(privacyLink).toHaveAttribute("href", "/privacy");

    expect(
      screen.getByRole("button", { name: "Cookie preferences" }),
    ).toBeInTheDocument();
  });

  it("uses the current year in the copyright line", () => {
    render(<SiteFooter />);
    const year = new Date().getFullYear();
    expect(screen.getByText(new RegExp(String(year)))).toBeInTheDocument();
  });
});

describe("SiteFooterLinks", () => {
  it("renders without its own wrapping element, so it can be embedded in a host footer", () => {
    const { container } = render(
      <footer>
        <SiteFooterLinks />
      </footer>,
    );
    // Only the host <footer> is present — SiteFooterLinks contributes a fragment.
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Privacy & Cookie Notice" }),
    ).toBeInTheDocument();
  });
});
