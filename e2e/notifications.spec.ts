import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A } from "./constants";

// Guards the notification bell in the global header: always interactive,
// and shows an empty-state when there are no active alerts.

test.describe("notifications", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("bell button is visible in the header", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.getByRole("button", { name: "Notifications" }),
    ).toBeVisible();
  });

  test("bell opens the notification popover on click", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByText("You're all caught up")).toBeVisible();
  });

  test("bell sets aria-expanded when the popover is open", async ({ page }) => {
    await page.goto("/dashboard");
    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell).toHaveAttribute("aria-expanded", "false");
    await bell.click();
    await expect(bell).toHaveAttribute("aria-expanded", "true");
  });

  test("bell popover closes on Escape and returns focus to trigger", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByText("You're all caught up")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByText("You're all caught up")).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Notifications" }),
    ).toBeFocused();
  });

  test("bell popover closes when clicking outside", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByText("You're all caught up")).toBeVisible();

    // Click the page heading — well outside the popover.
    await page.locator("header a", { hasText: "Baseline" }).click();
    await expect(page.getByText("You're all caught up")).not.toBeVisible();
  });

  test("bell popover toggles closed on a second click", async ({ page }) => {
    await page.goto("/dashboard");
    const bell = page.getByRole("button", { name: "Notifications" });
    await bell.click();
    await expect(page.getByText("You're all caught up")).toBeVisible();

    await bell.click();
    await expect(page.getByText("You're all caught up")).not.toBeVisible();
  });
});
