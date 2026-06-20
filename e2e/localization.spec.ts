import { test, expect } from "@playwright/test";
import { ANON_STATE, CONTRIBUTOR_A, TEAM_A_NAME } from "./constants";

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

// The authenticated app shell + Dashboard (issue #240). A signed-in contributor
// on /es sees Spanish chrome (AppShell namespace) and Spanish dashboard panels
// (Dashboard namespace), with the seeded team's data still driving the page.
test.describe("authenticated shell + dashboard localization", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("renders the Spanish shell and dashboard under /es/dashboard", async ({
    page,
  }) => {
    await page.goto("/es/dashboard");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized nav chrome (the Dashboard nav link is "Panel").
    await expect(page.getByRole("link", { name: "Panel" })).toBeVisible();

    // Localized dashboard panel headings.
    await expect(
      page.getByRole("heading", { name: "Clasificación de rúbricas" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Ejecuciones recientes" })
    ).toBeVisible();

    // The chart range control's Spanish span suffix ("· auto").
    await expect(page.getByTestId("chart-span")).toContainText("· auto");

    // The active team still drives the page.
    await expect(page.getByText(TEAM_A_NAME).first()).toBeVisible();
  });
});
