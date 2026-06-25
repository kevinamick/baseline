import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });
test.setTimeout(120_000);

// (1) Billing page (moved into (app)) loads its data — plan-card renders, NOT the
// #329 error boundary. If getOptimizationAllowance / optimization_run_balance
// genuinely failed post-move, this would hit the boundary and plan-card vanish.
test("billing page renders (not the error boundary) after the (app) move", async ({ page }) => {
  await page.goto("/settings/billing", { waitUntil: "commit" });
  await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 30_000 });
  // The overage card requires getOptimizationAllowance() to have succeeded.
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
});

// (2) Localization reaches the (app) routes: the [locale] segment resolves and
// the NextIntlClientProvider (in [locale]/layout, ancestor of (app)) supplies
// translations to the moved pages + the NavBar.
for (const { locale, navWord, urlRe } of [
  // `en` is the default locale: next-intl's as-needed prefix strips `/en`.
  { locale: "en", navWord: "Dashboard", urlRe: /\/dashboard$/ },
  { locale: "es", navWord: "Panel", urlRe: /\/es\/dashboard$/ },
  { locale: "fr", navWord: "Tableau de bord", urlRe: /\/fr\/dashboard$/ },
]) {
  test(`locale ${locale}: (app) dashboard renders translated nav`, async ({ page }) => {
    await page.goto(`/${locale}/dashboard`, { waitUntil: "commit" });
    // NavBar is a client component reading translations via NextIntlClientProvider.
    await expect(
      page.locator("header nav").getByRole("link", { name: navWord }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(urlRe);
  });
}
