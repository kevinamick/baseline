import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import { ANON_STATE } from "./constants";

// The /blog narrative-content surface (#435): a simple index + post route on the
// same lander machinery as the category/comparison pages. Public, signed-out
// marketing content — no seeded fixtures, no auth — so every spec runs anonymous,
// same as docs-seo.spec.ts and manual-prompt-optimization.spec.ts.

test.use({ storageState: ANON_STATE });

const POST_SLUG = "optimizer-prompt-dogfood";
const POST_HEADING =
  "We ran Baseline on our own advice, and the advice got 28 points better";

test.describe("landing entry points", () => {
  test("the landing nav and footer link to /blog", async ({ page }) => {
    await page.goto("/");

    // Desktop top nav (next to Resources) and the footer product column.
    const header = page.locator("header");
    await expect(header.getByRole("link", { name: "Blog" })).toHaveAttribute(
      "href",
      "/blog"
    );
    const footer = page.locator("footer");
    const footerBlog = footer.getByRole("link", { name: "Blog" });
    await expect(footerBlog).toHaveAttribute("href", "/blog");

    await footerBlog.click();
    await expect(page).toHaveURL(/\/blog$/);
    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
  });
});

test.describe("blog index", () => {
  test("renders and links to the case study post", async ({ page }) => {
    const response = await page.goto("/blog");
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();

    const postLink = page.locator(`a[href="/blog/${POST_SLUG}"]`);
    await expect(postLink).toHaveCount(1);
    await expect(postLink.getByRole("heading", { level: 2 })).toHaveText(
      POST_HEADING
    );
  });

  test("navigating from the index reaches the post", async ({ page }) => {
    await page.goto("/blog");
    await page.locator(`a[href="/blog/${POST_SLUG}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/blog/${POST_SLUG}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: POST_HEADING })
    ).toBeVisible();
  });
});

test.describe("youtube launch post (#YouTube)", () => {
  test("renders the video embed and the channel/X callouts", async ({ page }) => {
    // Keep CI hermetic: the privacy-enhanced embed would otherwise fetch the
    // real YouTube player. The element assertions don't need it to load.
    await page.route("**://www.youtube-nocookie.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<html></html>" })
    );
    const response = await page.goto("/blog/baseline-on-youtube");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Baseline is on YouTube: watch the optimization loop run",
      })
    ).toBeVisible();
    await expect(
      page.locator('iframe[src="https://www.youtube-nocookie.com/embed/ueNWzKoBEd8"]')
    ).toBeVisible();
    await expect(
      page.locator('a[href="https://www.youtube.com/@Baseline-u4g"]')
    ).toBeVisible();
    await expect(page.locator('a[href="https://x.com/baselinesam"]')).toBeVisible();
  });

  test("the index lists it newest-first", async ({ page }) => {
    await page.goto("/blog");
    const links = page.locator('a[href^="/blog/"]');
    await expect(links.first()).toHaveAttribute(
      "href",
      "/blog/baseline-on-youtube"
    );
  });
});

test.describe("case study post", () => {
  test("renders the full post: table, prompt excerpts, both images", async ({
    page,
  }) => {
    const response = await page.goto(`/blog/${POST_SLUG}`);
    expect(response?.status()).toBe(200);

    await expect(
      page.getByRole("heading", { level: 1, name: POST_HEADING })
    ).toBeVisible();

    // The before/after criterion table.
    await expect(
      page.getByRole("heading", { name: "The confirmation: 0.637 → 0.919" })
    ).toBeVisible();
    const table = page.locator("table");
    await expect(table).toHaveCount(1);
    await expect(table.getByText("Diagnosis quality")).toBeVisible();
    await expect(table.getByText("+0.282")).toBeVisible();

    // The two prompt excerpts, rendered preformatted.
    const preBlocks = page.locator("pre");
    await expect(preBlocks).toHaveCount(2);
    await expect(preBlocks.first()).toContainText(
      "helping me manually improve an AI prompt"
    );
    await expect(preBlocks.nth(1)).toContainText(
      "proceed immediately to scoring"
    );

    // Both embedded screenshots.
    await expect(
      page.getByAltText(/completed Optimization Run/i)
    ).toBeVisible();
    await expect(page.getByAltText(/Eval Runs panel/i)).toBeVisible();
  });

  test("the closing internal links navigate to the manual and automated guides", async ({
    page,
  }) => {
    await page.goto(`/blog/${POST_SLUG}`);

    const manualLink = page.getByRole("link", { name: "/manual-prompt-optimization" });
    await expect(manualLink).toHaveAttribute("href", "/manual-prompt-optimization");
    await manualLink.click();
    await expect(page).toHaveURL(/\/manual-prompt-optimization$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.goto(`/blog/${POST_SLUG}`);
    const automatedLink = page.getByRole("link", { name: "/prompt-optimization" });
    await expect(automatedLink).toHaveAttribute("href", "/prompt-optimization");
    await automatedLink.click();
    await expect(page).toHaveURL(/\/prompt-optimization$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("emits valid BlogPosting JSON-LD", async ({ page }) => {
    await page.goto(`/blog/${POST_SLUG}`);

    // Several JSON-LD blocks ride the post page: the site-wide Organization
    // graph (root layout), the page's own BlogPosting graph, and its
    // BreadcrumbList trail. All must be well-formed JSON — same assertion shape
    // as docs-seo.spec.ts. No nonce
    // attribute assertion, deliberately: the browser blanks a <script>'s
    // `nonce` content attribute after parsing (anti-exfiltration), so the live
    // DOM always reads nonce="" — and the strict CSP itself is the real check
    // (an un-nonced block under it wouldn't be trusted).
    const schemas = page.locator('script[type="application/ld+json"]');
    const count = await schemas.count();
    expect(count).toBeGreaterThan(0);

    const parsed: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const raw = await schemas.nth(i).textContent();
      expect(raw, `JSON-LD block ${i} has no content`).toBeTruthy();
      parsed.push(JSON.parse(raw ?? ""));
    }
    const types = parsed.map((s) => (s as { "@type"?: string })["@type"]);
    expect(types).toContain("BlogPosting");

    // The BlogPosting graph carries the post's own headline and publish date.
    const blogPosting = parsed.find(
      (s) => (s as { "@type"?: string })["@type"] === "BlogPosting"
    ) as { headline?: string; datePublished?: string };
    expect(blogPosting.headline).toBe(POST_HEADING);
    expect(blogPosting.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The BreadcrumbList places the post in the Home → Blog → post trail, so
    // search/answer engines can read the hierarchy. Positions run 1..n and the
    // leaf names the post itself.
    expect(types).toContain("BreadcrumbList");
    const breadcrumb = parsed.find(
      (s) => (s as { "@type"?: string })["@type"] === "BreadcrumbList"
    ) as { itemListElement?: { position: number; name: string }[] };
    const trail = breadcrumb.itemListElement ?? [];
    expect(trail.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(trail[trail.length - 1].name).toBe(POST_HEADING);
  });

  test("a non-English request 404s (ADR-0013 first-post scope)", async ({
    page,
  }) => {
    const response = await page.goto(`/es/blog/${POST_SLUG}`);
    expect(response?.status()).toBe(404);
  });

  test("an unknown slug 404s", async ({ page }) => {
    const response = await page.goto("/blog/not-a-real-post-xyz");
    expect(response?.status()).toBe(404);
  });
});

test.describe("og-image endpoints", () => {
  test("/blog/opengraph-image returns a PNG", async ({ page }) => {
    const response = await page.request.get("/blog/opengraph-image");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\//);
  });

  test(`/blog/${POST_SLUG}/opengraph-image returns a PNG`, async ({ page }) => {
    const response = await page.request.get(`/blog/${POST_SLUG}/opengraph-image`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\//);
  });
});

test.describe("accessibility", () => {
  const BLOCKING_IMPACTS = ["serious", "critical"];

  for (const path of ["/blog", `/blog/${POST_SLUG}`]) {
    test(`${path} has no serious/critical a11y violations`, async ({ page }) => {
      // Reduced motion settles reveal-on-scroll fades to their final, fully-opaque
      // state before the scan — otherwise axe measures mid-fade partial opacity
      // and reports spurious contrast failures (see a11y.spec.ts).
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(path);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact && BLOCKING_IMPACTS.includes(v.impact)
      );
      expect(
        blocking,
        `serious/critical a11y violations on ${path}:\n${blocking
          .map((v) => `  - ${v.id} (${v.impact}): ${v.help}`)
          .join("\n")}`
      ).toEqual([]);
    });
  }
});
