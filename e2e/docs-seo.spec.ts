import { test, expect } from "./fixtures";
import { ANON_STATE } from "./constants";
import { CATEGORY_SLUGS } from "../src/lib/marketing/categories";
import { COMPARISONS } from "../src/lib/marketing/comparisons";

// The SEO/marketing surface (#387, ADR-0013): the /docs resources hub, the six
// category "guide" landers, the competitor comparison pages, the shared 404, and
// the dynamic og-image endpoints. Everything here is public, signed-out marketing
// content — no seeded fixtures, no auth — so every spec runs anonymous.

test.use({ storageState: ANON_STATE });

const COMPARISON_SLUGS = COMPARISONS.map((c) => c.slug);

test.describe("docs hub", () => {
  test("renders and links to every guide and comparison page", async ({
    page,
  }) => {
    await page.goto("/docs");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Resources");

    for (const slug of CATEGORY_SLUGS) {
      await expect(page.locator(`a[href="/${slug}"]`)).toHaveCount(1);
    }
    for (const slug of COMPARISON_SLUGS) {
      await expect(page.locator(`a[href="/compare/${slug}"]`)).toHaveCount(1);
    }
  });

  for (const slug of CATEGORY_SLUGS) {
    test(`the "${slug}" guide linked from /docs renders its H1 with no error boundary`, async ({
      page,
    }) => {
      const response = await page.goto(`/${slug}`);
      expect(response?.status()).toBe(200);

      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toBeVisible();
      await expect(h1).not.toHaveText("");

      // A thrown render error would fall through to the Next.js default error
      // page (see global-error.tsx), which replaces the whole document with
      // this heading instead of the guide's own chrome.
      await expect(page.getByText("Application error", { exact: false })).toHaveCount(
        0
      );
    });
  }
});

test.describe("category pages", () => {
  for (const slug of CATEGORY_SLUGS) {
    test(`/${slug} renders an H1, a signup CTA, and valid JSON-LD`, async ({
      page,
    }) => {
      await page.goto(`/${slug}`);

      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // The shared category-route header's conversion CTA (#278).
      const signupCta = page.getByRole("link", { name: "Get started free" });
      await expect(signupCta).toBeVisible();
      await expect(signupCta).toHaveAttribute("href", "/sign-up");

      // Two JSON-LD blocks ride every category page: the site-wide Organization
      // graph (root layout) and the page's own SoftwareApplication graph
      // (category-route.tsx). Both must be well-formed JSON.
      const schemas = page.locator('script[type="application/ld+json"]');
      const count = await schemas.count();
      expect(count).toBeGreaterThan(0);

      const parsed: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const raw = await schemas.nth(i).textContent();
        expect(raw, `JSON-LD block ${i} on /${slug} has no content`).toBeTruthy();
        parsed.push(JSON.parse(raw ?? ""));
      }
      const types = parsed.map((s) => (s as { "@type"?: string })["@type"]);
      expect(types).toContain("SoftwareApplication");
    });
  }
});

test.describe("comparison pages", () => {
  for (const comparison of COMPARISONS) {
    test(`/compare/${comparison.slug} renders the ${comparison.competitor} comparison`, async ({
      page,
    }) => {
      const response = await page.goto(`/compare/${comparison.slug}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        comparison.heading
      );
    });
  }

  test("an unknown competitor 404s", async ({ page }) => {
    const response = await page.goto("/compare/not-a-real-competitor-xyz");
    expect(response?.status()).toBe(404);
  });
});

test.describe("404", () => {
  test("an unknown route under a public surface returns the not-found page with status 404", async ({
    page,
  }) => {
    // A fully unrouted top-level path (e.g. /this-route-does-not-exist) is
    // indistinguishable from a protected route to the signed-out proxy gate
    // (src/proxy.ts's PUBLIC_ROUTES allowlist) and gets redirected to /sign-in
    // instead of ever reaching Next's not-found renderer. Nesting under an
    // already-public prefix (a category lander) reaches the real 404 render
    // without that redirect getting in the way.
    const response = await page.goto("/llm-evaluation/this-guide-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page" })
    ).toBeVisible();
  });

  test("the not-found page offers a way back to the app", async ({ page }) => {
    await page.goto("/llm-evaluation/this-guide-does-not-exist");
    // Primary CTA back to the home page, plus a secondary dashboard CTA.
    const homeLink = page.getByRole("link", { name: "Back to home" });
    await expect(homeLink).toBeVisible();
    await expect(homeLink).toHaveAttribute("href", "/");
    await expect(
      page.getByRole("link", { name: "Go to dashboard" })
    ).toBeVisible();
  });

  test("the not-found page respects a dark-theme visitor", async ({ browser }) => {
    // The not-found boundary ships an empty server shell, so the layout's
    // pre-paint theme script never runs there — the page re-stamps the theme
    // from the client bundle instead (theme-stamp.tsx). Regression guard: a
    // dark-scheme visitor must not get a light 404.
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/llm-evaluation/this-guide-does-not-exist");
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page" })
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await ctx.close();
  });
});

test.describe("og-image endpoints", () => {
  for (const slug of ["llm-evaluation", "rubric-based-evaluation"]) {
    test(`/${slug}/opengraph-image returns a PNG`, async ({ page }) => {
      const response = await page.request.get(`/${slug}/opengraph-image`);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toMatch(/^image\//);
    });
  }
});
