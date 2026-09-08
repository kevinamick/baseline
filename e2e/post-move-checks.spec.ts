import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });
test.setTimeout(120_000);

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
