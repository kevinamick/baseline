import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A, CONTRIBUTOR_C } from "./constants";

// Free-plan upsell CTAs (#349). Team A (CONTRIBUTOR_A) is the seeded Free team;
// Team C (CONTRIBUTOR_C) is Builder-subscribed (paid). optimizations.spec.ts
// already covers the optimizations page's own gates in depth (the "+ New run"
// button, the wizard) — these specs focus on the nav/account-menu CTAs (#349)
// plus the allowance chip's plan-aware copy.

const PHONE = { width: 390, height: 844 };

test.describe("free plan — desktop nav upsell", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("shows a bolded Upgrade button in the top nav", async ({ page }) => {
    await page.goto("/dashboard");
    const cta = page.getByTestId("nav-upgrade-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/pricing");
  });

  test("shows an upgrade CTA in the account-menu dropdown", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Account" }).click();
    const cta = page.getByTestId("account-menu-upgrade-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/pricing");
  });

  test("the optimizations page shows \"0 available\" and the upgrade gate", async ({
    page,
  }) => {
    await page.goto("/optimizations");
    await expect(page.getByText("0 available")).toBeVisible();
    await expect(page.getByTestId("optimization-gate")).toContainText(
      "Upgrade to optimize"
    );
    await expect(page.getByRole("button", { name: "+ New run" })).toHaveCount(0);
  });
});

test.describe("paid plan — desktop nav has no upsell", () => {
  test.use({ storageState: CONTRIBUTOR_C.storageState });

  test("no Upgrade button in the top nav", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("nav-upgrade-cta")).toHaveCount(0);
  });

  test("no upgrade CTA in the account-menu dropdown", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByTestId("account-menu-upgrade-cta")).toHaveCount(0);
  });
});

test.describe("mobile nav sheet upsell", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState, viewport: PHONE });

  test("the sheet shows the Upgrade CTA for a Free-plan user", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Menu" }).click();
    const sheet = page.getByTestId("nav-menu-sheet");
    const cta = sheet.getByTestId("mobile-nav-upgrade-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/pricing");
  });
});

test.describe("mobile nav sheet — paid plan has no upsell", () => {
  test.use({ storageState: CONTRIBUTOR_C.storageState, viewport: PHONE });

  test("the sheet has no Upgrade CTA for a paid-plan user", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Menu" }).click();
    const sheet = page.getByTestId("nav-menu-sheet");
    await expect(sheet.getByTestId("mobile-nav-upgrade-cta")).toHaveCount(0);
  });
});
