import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A } from "./constants";

// Dark mode is attribute-driven: a pre-paint inline script stamps
// [data-theme] on <html> (carrying the per-request CSP nonce so 'strict-dynamic'
// doesn't block it), and a Light/System/Dark control in the settings menu writes
// the preference. These specs guard the end-to-end behavior.

test.describe("dark mode", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("stamps a resolved theme before paint (inline script runs under CSP)", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    // If the nonce were missing, 'strict-dynamic' would block the script and the
    // attribute would never be set — so this also guards the CSP-nonce wiring.
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      /^(light|dark)$/,
    );
  });

  test("settings menu exposes a Light / System / Dark control", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Settings" }).click();

    const group = page.getByRole("radiogroup", { name: "Theme" });
    await expect(group).toBeVisible();
    for (const name of ["Light", "System", "Dark"]) {
      await expect(group.getByRole("radio", { name })).toBeVisible();
    }
  });

  test("selecting Dark re-themes the app, marks the option, and persists", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const bgLight = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: "Dark" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

    // The CSS variables actually re-theme the page, not just the attribute.
    // Poll the computed background: the [data-theme] attribute flips before the
    // browser has necessarily repainted the body from the new custom properties,
    // so a one-shot read races the repaint on slow CI.
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      )
      .not.toBe(bgLight);

    // The explicit choice survives a reload (persisted to localStorage).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test.describe("with an OS dark preference", () => {
    test.use({ colorScheme: "dark" });

    test("follows the OS scheme by default (no stored choice)", async ({
      page,
    }) => {
      // A fresh context has no stored preference, so 'system' resolves to the OS.
      await page.goto("/dashboard");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });
  });
});
