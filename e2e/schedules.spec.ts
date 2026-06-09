import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A, SCHEDULE_NAME } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test("schedules list shows the seeded schedule", async ({ page }) => {
  await page.goto("/schedules");
  // sr-only <h1>Schedules</h1> + panel <h2>Schedules</h2> share the name.
  await expect(
    page.getByRole("heading", { name: "Schedules" }).first(),
  ).toBeVisible();
  await expect(page.getByText(SCHEDULE_NAME).first()).toBeVisible();
});

test("a Contributor sees the create control", async ({ page }) => {
  await page.goto("/schedules");
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});

test("selecting the schedule shows its detail", async ({ page }) => {
  await page.goto("/schedules");
  await page.getByText(SCHEDULE_NAME).first().click();
  await expect(
    page.getByRole("heading", { name: SCHEDULE_NAME }),
  ).toBeVisible();
});
