import { test, expect } from "@playwright/test";
import { ANON_STATE } from "./constants";

// The funnel localization (issue #28, ADR-0011): English is the source language
// and renders unprefixed (`/pricing`); Spanish is prefixed (`/es/pricing`).
// All public marketing surfaces, signed out.
test.use({ storageState: ANON_STATE });

test.describe("funnel localization", () => {
  test("English is served unprefixed at the root", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("link", { name: "Pricing" })).toBeVisible();
  });

  test("Spanish landing renders under /es", async ({ page }) => {
    await page.goto("/es");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    // Nav pill + hero highlight are translated.
    await expect(page.getByRole("link", { name: "Precios" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("rigor");
  });

  test("Spanish pricing renders under /es/pricing", async ({ page }) => {
    await page.goto("/es/pricing");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(
      page.getByRole("heading", { name: "Precios que escalan con tus evaluaciones" })
    ).toBeVisible();
    // Plan tier names stay English proper nouns (ADR-0011).
    await expect(page.getByRole("heading", { name: "Builder" })).toBeVisible();
  });

  test("emits hreflang alternates + a self-canonical for SEO", async ({
    page,
  }) => {
    await page.goto("/es/pricing");
    await expect(
      page.locator('link[rel="alternate"][hreflang="es"]')
    ).toHaveCount(1);
    await expect(
      page.locator('link[rel="alternate"][hreflang="en"]')
    ).toHaveCount(1);
    await expect(
      page.locator('link[rel="canonical"]')
    ).toHaveAttribute("href", /\/es\/pricing$/);
  });
});
