import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A, TEAM_A_NAME, RUBRIC_SUPPORT } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test("dashboard renders the active team and seeded panels", async ({ page }) => {
  await page.goto("/dashboard");

  // Team pill in the nav.
  await expect(page.getByText(TEAM_A_NAME).first()).toBeVisible();

  // Seeded data drives these panels.
  await expect(
    page.getByRole("heading", { name: "Rubric leaderboard" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent runs" })).toBeVisible();

  // A seeded rubric shows up in the leaderboard.
  await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
});
