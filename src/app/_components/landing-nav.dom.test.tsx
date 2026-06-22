// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";

// The nav links via next-intl's locale-aware navigation; stub it with a plain
// anchor so assertions stay on href + label (locale prefixing is an e2e concern).
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
// Resolve translations against the real English catalog so the assertions can
// look for the shipped English labels without standing up an intl provider.
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json"))
    .default as unknown as Record<string, Record<string, string>>;
  return {
    useTranslations: (ns: string) => (key: string) => en[ns]?.[key] ?? key,
  };
});
// BrandMark renders next/image; swap for a plain img so the decorative mark
// doesn't pull the optimizer into the jsdom run.
vi.mock("next/image", () => ({
  default: ({ alt = "", src }: { alt?: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} src={typeof src === "string" ? src : ""} />
  ),
}));
// The auth CTAs + sign-out fire analytics and post a server action; stub both so
// the nav renders standalone.
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn(), reset: vi.fn() }));
vi.mock("@/app/actions/auth", () => ({ signOut: vi.fn() }));

import { LandingNav } from "./landing-nav";

beforeEach(() => {
  vi.clearAllMocks();
  // Each test drives scrollY itself; start at the top.
  Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
});

afterEach(() => {
  Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
});

describe("LandingNav — in-page jump links", () => {
  it("renders the section jump links in scroll order with matching anchors", () => {
    render(<LandingNav signedIn={false} canSubscribe={false} />);

    // The brand wordmark jumps to the top of the page.
    expect(screen.getByRole("link", { name: "Baseline" })).toHaveAttribute("href", "#top");

    // Order matters: the labels must follow the order the sections appear. Scope
    // to the in-page section jumps (anchor hrefs) — the nav also carries the
    // Resources page link, asserted separately below.
    const nav = screen.getByRole("navigation");
    const jumps = within(nav)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("#"));
    expect(jumps.map((a) => a.textContent)).toEqual([
      "The problem",
      "Optimization",
      "Features",
    ]);
    expect(jumps.map((a) => a.getAttribute("href"))).toEqual([
      "#problem",
      "#optimize",
      "#features",
    ]);

    // The Resources link is a page nav (not a section jump), so it points at the
    // /docs route rather than an anchor.
    expect(
      within(nav).getByRole("link", { name: "Resources" }),
    ).toHaveAttribute("href", "/docs");
  });
});

describe("LandingNav — signed-out cluster", () => {
  it("offers Pricing, Sign in, and Get started, but no app/sign-out controls", () => {
    render(<LandingNav signedIn={false} canSubscribe={false} />);

    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("link", { name: "Get started free" })).toHaveAttribute(
      "href",
      "/sign-up"
    );

    // Authenticated-only affordances stay hidden for anonymous visitors.
    expect(screen.queryByRole("link", { name: /Open Baseline/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});

describe("LandingNav — signed-in cluster", () => {
  it("shows Open Baseline + View plans + Sign out when the team can still subscribe", () => {
    render(<LandingNav signedIn canSubscribe />);

    expect(screen.getByRole("link", { name: /Open Baseline/ })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    // The signed-out conversion CTAs are gone.
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Get started free" })).not.toBeInTheDocument();
  });

  it("drops View plans once the team is already subscribed", () => {
    render(<LandingNav signedIn canSubscribe={false} />);

    expect(screen.getByRole("link", { name: /Open Baseline/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View plans" })).not.toBeInTheDocument();
    // Sign out still available.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("LandingNav — scroll affordance", () => {
  it("is transparent at the top and gains a blurred hairline once scrolled past the threshold", () => {
    render(<LandingNav signedIn={false} canSubscribe={false} />);
    const header = screen.getByRole("banner");

    // At rest (scrollY 0) the bar is borderless and see-through.
    expect(header.className).toContain("border-transparent");
    expect(header.className).not.toContain("backdrop-blur");

    // Scroll past 12px and dispatch the scroll event the listener is bound to.
    Object.defineProperty(window, "scrollY", { value: 40, writable: true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });

    expect(header.className).toContain("backdrop-blur");
    expect(header.className).toContain("border-hairline-cool");
    expect(header.className).not.toContain("border-transparent");
  });
});
