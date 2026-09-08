// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) =>
    ({ pricing: "Pricing", openBaseline: "Open Baseline" })[key] ?? key,
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

import { MarketingHeader } from "./marketing-header";

describe("MarketingHeader (no sign-in, ADR-0020)", () => {
  it("always offers Open Baseline → /dashboard plus the wordmark home link", async () => {
    render(await MarketingHeader());

    expect(screen.getByRole("link", { name: "Open Baseline" })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    expect(screen.getByRole("link", { name: "Baseline" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: /Get started/ })).not.toBeInTheDocument();
  });
});
