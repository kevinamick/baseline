import { test, expect } from "@playwright/test";
import { ANON_STATE, CONTRIBUTOR_A, RUBRIC_SUPPORT } from "./constants";

// Mobile responsive pass (#282). The DOM tests cover NavMenuSheet's focus/scroll
// mechanics in isolation; these specs exercise the assembled behavior in a real
// browser at a phone viewport (390 × 844, ~iPhone 14): the nav collapsing into
// the shared paper-sheet menu, and the rubrics split-pane drill-in. Everything
// is gated behind sm/md, so a desktop-width run would see none of it — each
// describe pins the mobile viewport.

const PHONE = { width: 390, height: 844 };

test.describe("mobile — landing nav (signed out)", () => {
  test.use({ storageState: ANON_STATE, viewport: PHONE });

  test("collapses to a hamburger that opens the paper-sheet menu", async ({
    page,
  }) => {
    await page.goto("/");
    const nav = page.getByRole("banner");

    // Below md the jump links and the secondary actions leave the bar; only the
    // primary conversion CTA stays inline.
    await expect(nav.getByRole("link", { name: "The problem" })).toBeHidden();
    await expect(nav.getByRole("link", { name: "Sign in" })).toBeHidden();
    await expect(
      nav.getByRole("link", { name: "Get started free" })
    ).toBeVisible();

    const trigger = nav.getByRole("button", { name: "Menu" });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The sheet surfaces the links that left the bar.
    const sheet = page.getByTestId("nav-menu-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("link", { name: "The problem" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Pricing" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("a sheet jump link scrolls to its section and closes the sheet", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("banner").getByRole("button", { name: "Menu" }).click();

    const sheet = page.getByTestId("nav-menu-sheet");
    await sheet.getByRole("link", { name: "Features" }).click();

    await expect(page).toHaveURL(/#features$/);
    await expect(page.locator("#features")).toBeInViewport();
    await expect(sheet).toBeHidden();
  });

  test("Escape closes the sheet and returns focus to the trigger", async ({
    page,
  }) => {
    await page.goto("/");
    const trigger = page
      .getByRole("banner")
      .getByRole("button", { name: "Menu" });

    await trigger.click();
    await expect(page.getByTestId("nav-menu-sheet")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-menu-sheet")).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe("mobile — app shell nav (signed in)", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState, viewport: PHONE });

  test("collapses the destinations into the sheet and navigates", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    // The hamburger is the only nav trigger on mobile; the center destination
    // pills have left the bar.
    const trigger = page.getByRole("button", { name: "Menu" });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const sheet = page.getByTestId("nav-menu-sheet");
    await expect(sheet.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Rubrics" })).toBeVisible();

    await sheet.getByRole("link", { name: "Rubrics" }).click();
    await expect(page).toHaveURL(/\/rubrics$/);
    await expect(sheet).toBeHidden();
  });
});

test.describe("mobile — rubrics drill-in (signed in)", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState, viewport: PHONE });

  test("drills from the list into a rubric's runs and back", async ({
    page,
  }) => {
    await page.goto("/rubrics");

    // List owns the screen first; the runs pane (its Run eval control) is not
    // shown until a rubric is picked.
    const rubric = page.getByRole("button", { name: RUBRIC_SUPPORT });
    await expect(rubric).toBeVisible();
    await expect(page.getByRole("button", { name: "Run eval" })).toBeHidden();

    // Drill in → the runs pane takes over, the list steps aside.
    await rubric.click();
    await expect(page.getByRole("button", { name: "Run eval" })).toBeVisible();
    await expect(rubric).toBeHidden();

    // The back affordance returns to the list.
    await page.getByRole("button", { name: "Back to rubrics" }).click();
    await expect(rubric).toBeVisible();
    await expect(page.getByRole("button", { name: "Run eval" })).toBeHidden();
  });
});
