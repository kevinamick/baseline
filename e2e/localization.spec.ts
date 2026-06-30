import { test, expect } from "@playwright/test";
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
  test("English is served unprefixed at the root", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // "Pricing" also appears in the final-CTA and footer; assert the nav pill.
    await expect(
      page.getByRole("banner").getByRole("link", { name: "Pricing" })
    ).toBeVisible();
  });

  test("Spanish landing renders under /es", async ({ page }) => {
    await page.goto("/es");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    // Nav pill + hero highlight are translated.
    await expect(
      page.getByRole("banner").getByRole("link", { name: "Precios" })
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("resultados");
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

  test("French landing renders under /fr", async ({ page }) => {
    await page.goto("/fr");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(
      page.getByRole("banner").getByRole("link", { name: "Tarifs" })
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("résultats");
  });

  test("French pricing renders under /fr/pricing", async ({ page }) => {
    await page.goto("/fr/pricing");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(
      page.getByRole("heading", { name: "Des tarifs qui évoluent avec vos évaluations" })
    ).toBeVisible();
    // Plan tier names stay English proper nouns (ADR-0011).
    await expect(page.getByRole("heading", { name: "Builder" })).toBeVisible();
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

// The entry-flow surfaces (issue #246). The standalone auth forms + onboarding
// + invite-accept chrome. Sign-in and forgot-password are anon-accessible, so
// they exercise the Auth namespace under the default ANON storage state.
test.describe("entry-flow localization", () => {
  test("renders the Spanish sign-in form under /es/sign-in", async ({
    page,
  }) => {
    await page.goto("/es/sign-in");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized heading + primary action (Auth namespace). "Baseline" stays English.
    await expect(
      page.getByRole("heading", { name: "Inicia sesión en Baseline" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Iniciar sesión" })
    ).toBeVisible();
    // The forgot-password link is localized.
    await expect(
      page.getByRole("link", { name: "¿Olvidaste tu contraseña?" })
    ).toBeVisible();
  });

  test("renders the Spanish forgot-password form under /es/forgot-password", async ({
    page,
  }) => {
    await page.goto("/es/forgot-password");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await expect(
      page.getByRole("heading", { name: "Restablece tu contraseña" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Enviar enlace de restablecimiento" })
    ).toBeVisible();
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

    // The primary "new run" entry point is localized for a contributor. On the
    // Free seed plan this surfaces as the upgrade gate (still Spanish chrome).
    await expect(page.getByText("Mejora tu plan para optimizar →")).toBeVisible();
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

  test("renders the Spanish account settings under /es/settings/account", async ({
    page,
  }) => {
    await page.goto("/es/settings/account");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await expect(
      page.getByRole("heading", { name: "Cuenta", level: 1 })
    ).toBeVisible();
    // Localized section headings + the danger-zone action.
    await expect(
      page.getByRole("heading", { name: "Perfil", level: 2 })
    ).toBeVisible();
    // The delete action sits behind a two-stage expandable danger zone: the
    // neutral trigger ("Eliminar cuenta") reveals the localized execution
    // button ("Eliminar mi cuenta") only once expanded.
    await page.getByRole("button", { name: "Eliminar cuenta" }).click();
    await expect(
      page.getByRole("button", { name: "Eliminar mi cuenta" })
    ).toBeVisible();
  });

  test("renders the Spanish billing settings under /es/settings/billing", async ({
    page,
  }) => {
    await page.goto("/es/settings/billing");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await expect(
      page.getByRole("heading", { name: "Facturación", level: 1 })
    ).toBeVisible();
    // "Eval Points" stays English; target the section heading (the phrase also
    // appears in the ledger blurb, so a plain getByText is ambiguous).
    await expect(page.getByText("Plan actual")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Eval Points" })
    ).toBeVisible();
  });

  test("renders the Spanish team settings under /es/settings/team", async ({
    page,
  }) => {
    await page.goto("/es/settings/team");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    // Localized section heading + invite action.
    await expect(
      page.getByRole("heading", { name: "Miembros", level: 2 })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Enviar invitación" })
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
