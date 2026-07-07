import { test, expect } from "./fixtures";
import { ANON_STATE, CONTRIBUTOR_A } from "./constants";

// The marketing landing page (issue #282 review follow-up). DOM tests cover the
// client components in isolation (landing-nav, reveal, hero-result-card); these
// specs exercise the assembled, server-rendered page in a real browser: the
// auth-aware nav, in-page jump-link scrolling, and the shared footer links.

test.describe("landing — signed out", () => {
  test.use({ storageState: ANON_STATE });

  test("renders the hero, conversion CTAs, and the anonymous nav cluster", async ({
    page,
  }) => {
    await page.goto("/");

    // Hero headline (the highlighted noun lives in a span inside the h1).
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toContainText("results");
    await expect(h1).toContainText("Take every project");

    // The nav's right cluster is the anonymous conversion set.
    const nav = page.getByRole("banner");
    await expect(nav.getByRole("link", { name: "Pricing" })).toHaveAttribute(
      "href",
      "/pricing"
    );
    await expect(nav.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in"
    );
    await expect(
      nav.getByRole("link", { name: "Get started free" })
    ).toHaveAttribute("href", "/sign-up");

    // Authenticated affordances are absent.
    await expect(nav.getByRole("link", { name: /Open Baseline/ })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("nav jump links carry the in-page section anchors in scroll order", async ({
    page,
  }) => {
    await page.goto("/");
    const nav = page.getByRole("banner");

    await expect(nav.getByRole("link", { name: "The problem" })).toHaveAttribute(
      "href",
      "#problem"
    );
    await expect(nav.getByRole("link", { name: "Optimization" })).toHaveAttribute(
      "href",
      "#optimize"
    );
    await expect(nav.getByRole("link", { name: "Features" })).toHaveAttribute(
      "href",
      "#features"
    );
  });

  test("clicking a jump link scrolls the target section into view", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("banner").getByRole("link", { name: "Features" }).click();

    // The hash updates and the Features section is scrolled into the viewport.
    await expect(page).toHaveURL(/#features$/);
    const features = page.locator("#features");
    await expect(features).toBeInViewport();
  });

  test("the footer carries the shared compliance links", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");

    // Single-sourced from <SiteFooterLinks/> — same links as /pricing and /privacy.
    await expect(footer.getByRole("link", { name: "Privacy & Cookie Notice" })).toHaveAttribute(
      "href",
      "/privacy"
    );
    await expect(
      footer.getByRole("button", { name: "Cookie preferences" })
    ).toBeVisible();

    // The landing-specific product column links into the page sections + pricing.
    await expect(footer.getByRole("link", { name: "Pricing" })).toHaveAttribute(
      "href",
      "/pricing"
    );
  });
});

test.describe("landing — signed in", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("swaps the conversion CTAs for app + sign-out controls", async ({
    page,
  }) => {
    await page.goto("/");
    const nav = page.getByRole("banner");

    // Open Baseline → the app; sign-out available. The seeded team is on Free and
    // unsubscribed, so the plan link is offered too.
    await expect(nav.getByRole("link", { name: /Open Baseline/ })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    await expect(nav.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/pricing"
    );
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();

    // The anonymous conversion CTAs are gone.
    await expect(nav.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Get started free" })).toHaveCount(0);
  });
});
