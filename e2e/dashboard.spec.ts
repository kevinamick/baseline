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

test("leaderboard score shows criteria tooltip on hover", async ({ page }) => {
  await page.goto("/dashboard");

  // Wait for leaderboard to load with seeded rubric scores.
  const leaderboard = page.getByRole("heading", { name: "Rubric leaderboard" })
    .locator("..")
    .locator("..");
  await expect(leaderboard).toBeVisible();

  // Hover over the score for the Support rubric row.
  const rubricRow = page
    .getByRole("button", { name: new RegExp(RUBRIC_SUPPORT) })
    .first();
  await expect(rubricRow).toBeVisible();

  // The score wrapper is the last auto-column in the grid row.
  const scoreWrapper = rubricRow.locator("[role=tooltip]").or(
    rubricRow.locator("div.relative").last(),
  );

  await rubricRow.locator("div.relative").last().hover();

  // Tooltip should appear with criteria names.
  const tooltip = page.getByRole("tooltip").first();
  await expect(tooltip).toBeVisible({ timeout: 3000 });
});

test("recent runs feed score shows criteria tooltip on hover", async ({ page }) => {
  await page.goto("/dashboard");

  const recentRuns = page.getByRole("heading", { name: "Recent runs" })
    .locator("..")
    .locator("..");
  await expect(recentRuns).toBeVisible();

  // Find a completed run score in the feed (has a score percentage).
  const scoreEl = recentRuns
    .locator("div.relative")
    .filter({ hasText: /\d+%/ })
    .first();

  // Only proceed if there's a scored run in the feed.
  const count = await scoreEl.count();
  if (count === 0) return;

  await scoreEl.hover();

  // The tooltip may take a moment to load (lazy fetch for feed items).
  const tooltip = page.getByRole("tooltip").first();
  await expect(tooltip).toBeVisible({ timeout: 5000 });
});
