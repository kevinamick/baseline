import { test, expect } from "./fixtures";
import {
  ANON_STATE,
  CONTRIBUTOR_A,
  RUBRIC_SUPPORT,
  SCHEDULE_NAME,
  TEAM_A_NAME,
} from "./constants";

// The funnel localization (issue #28, ADR-0011): English is the source language
// and renders unprefixed (`/pricing`); Spanish is prefixed (`/es/pricing`).
// All public marketing surfaces, signed out.
test.use({ storageState: ANON_STATE });

test.describe("funnel localization", () => {
  test("English is served unprefixed: the root opens the dashboard (ADR-0020)", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("Spanish privacy notice renders under /es/privacy", async ({ page }) => {
    await page.goto("/es/privacy");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(
      page.getByRole("heading", { name: "Aviso de privacidad y cookies" })
    ).toBeVisible();
    // A keyed body section + the locale-formatted "last updated" date.
    await expect(
      page.getByRole("heading", { name: "Quiénes somos" })
    ).toBeVisible();
    await expect(page.getByText(/18 de junio de 2026/)).toBeVisible();
  });

  test("emits hreflang alternates + a self-canonical for SEO", async ({
    page,
  }) => {
    await page.goto("/es/docs");
    await expect(
      page.locator('link[rel="alternate"][hreflang="es"]')
    ).toHaveCount(1);
    await expect(
      page.locator('link[rel="alternate"][hreflang="en"]')
    ).toHaveCount(1);
    await expect(
      page.locator('link[rel="canonical"]')
    ).toHaveAttribute("href", /\/es\/docs$/);
  });
});

// The one spec that must actually SEE the consent banner, so it opts out of the
// suite-wide consent-cookie fixture (which suppresses the banner everywhere else
// so it can't intercept lower-left clicks).
test.describe("cookie-consent banner (first-time visitor)", () => {
  test.use({ storageState: ANON_STATE, suppressConsentBanner: false });

  test("Spanish cookie-consent banner shows for a first-time visitor", async ({
    page,
  }) => {
    await page.goto("/es");
    const banner = page.getByRole("region", {
      name: "Consentimiento de cookies",
    });
    await expect(banner).toBeVisible();
    // exact: the body copy also contains the substring "usamos cookies".
    await expect(
      banner.getByText("Usamos cookies", { exact: true })
    ).toBeVisible();
    await expect(banner.getByRole("button", { name: "Aceptar" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Rechazar" })).toBeVisible();
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

// The authenticated Rubrics area (issue #243). A signed-in contributor on
// /es/rubrics sees Spanish chrome (Rubrics namespace), with the seeded team's
// rubrics still driving the list — user-authored rubric names stay verbatim.
test.describe("authenticated rubrics localization", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("renders the Spanish rubrics area under /es/rubrics", async ({
    page,
  }) => {
    await page.goto("/es/rubrics");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized list panel heading + KPI label.
    await expect(
      page.getByRole("heading", { name: "Rúbricas", level: 2 })
    ).toBeVisible();
    await expect(page.getByText("Puntuación media")).toBeVisible();

    // The "new rubric" button is localized for a contributor.
    await expect(page.getByRole("button", { name: "Nueva" })).toBeVisible();

    // A seeded, user-authored rubric name renders untranslated.
    await expect(page.getByText(RUBRIC_SUPPORT)).toBeVisible();
  });
});

// The authenticated Optimizations area (issue #244). A signed-in contributor on
// /es/optimizations sees Spanish chrome (Optimizations namespace).
test.describe("authenticated optimizations localization", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("renders the Spanish optimizations area under /es/optimizations", async ({
    page,
  }) => {
    await page.goto("/es/optimizations");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized list panel heading.
    await expect(
      page.getByRole("heading", { name: "Optimizaciones", level: 2 })
    ).toBeVisible();

    // The primary "new run" entry point is localized for the Contributor.
    await expect(page.getByRole("button", { name: "+ Nueva ejecución" })).toBeVisible();
  });
});

// The authenticated Schedules area (issue #244). A signed-in contributor on
// /es/schedules sees Spanish chrome (Schedules namespace), with the seeded
// team's schedule still driving the list — user-authored names stay verbatim.
test.describe("authenticated schedules localization", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("renders the Spanish schedules area under /es/schedules", async ({
    page,
  }) => {
    await page.goto("/es/schedules");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized list panel heading.
    await expect(
      page.getByRole("heading", { name: "Programaciones", level: 2 })
    ).toBeVisible();

    // The "new schedule" button is localized for a contributor.
    await expect(page.getByRole("button", { name: "Nueva" })).toBeVisible();

    // A seeded, user-authored schedule name renders untranslated.
    await expect(page.getByText(SCHEDULE_NAME)).toBeVisible();
  });
});

// The authenticated Settings area (issue #245). A signed-in contributor on
// /es/settings/* sees Spanish chrome (Settings namespace), with the seeded
// team's data still driving the page — user-authored names/emails stay verbatim.
// Plan tier names ("Free"/"Builder") and "Eval Points" stay English.
test.describe("authenticated settings localization", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("renders the Spanish team settings under /es/settings/team", async ({
    page,
  }) => {
    await page.goto("/es/settings/team");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized section heading (the page is the Workspace's provider keys, ADR-0020).
    await expect(
      page.getByRole("heading", { name: "Claves de proveedor", level: 2 })
    ).toBeVisible();

    // The seeded team's name still drives the page (user-authored, untranslated).
    await expect(page.getByText(TEAM_A_NAME).first()).toBeVisible();
  });

  test("renders the Spanish connections settings under /es/settings/connections", async ({
    page,
  }) => {
    await page.goto("/es/settings/connections");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await expect(
      page.getByRole("heading", { name: "Conexiones", level: 1 })
    ).toBeVisible();
    await expect(
      page.getByText(
        "Los sistemas que Baseline alcanza — agentes en vivo y fuentes de datos. Las conexiones de agente pueden declarar módulos optimizables aquí."
      )
    ).toBeVisible();
  });
});
