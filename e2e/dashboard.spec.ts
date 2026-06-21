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

test("chart range control defaults to Auto; presets pin and persist in the URL", async ({ page }) => {
  await page.goto("/dashboard");

  // Auto is the default mode and the chart header shows the fitted span.
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toBeVisible();
  await expect(page.getByTestId("chart-span")).toContainText("· auto");

  // Picking a preset pins it, relabels the span, and lands in the URL so the
  // view survives refresh / can be shared.
  await page.getByRole("button", { name: "90d", exact: true }).click();
  await expect(page.getByTestId("chart-span")).toContainText("· 90d");
  await expect(page).toHaveURL(/range=90/);

  // Back to Auto cleans the param away.
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await expect(page).not.toHaveURL(/range=/);
});

test("drag-to-zoom brushes a custom span; double-click resets to Auto", async ({ page }) => {
  await page.goto("/dashboard");

  const chart = page
    .locator("section", { has: page.getByRole("heading", { name: "Score over time" }) })
    .locator("svg")
    .first();
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;

  // Drag across the middle of the plot — past the 8px click threshold.
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByTestId("chart-span")).toContainText("· custom");
  await expect(page).toHaveURL(/range=\d+-\d+/);

  await chart.dblclick();
  await expect(page.getByTestId("chart-span")).toContainText("· auto");
});

test("leaderboard score shows criteria tooltip on hover", async ({ page }) => {
  await page.goto("/dashboard");

  // Wait for leaderboard to load with seeded rubric scores. Locate the section
  // structurally (the heading is nested in a header wrapper, so `..` climbing
  // lands on the wrong ancestor).
  const leaderboard = page.locator("section", {
    has: page.getByRole("heading", { name: "Rubric leaderboard" }),
  });
  await expect(leaderboard).toBeVisible();

  // Hover over the score for the Support rubric row. Scope to the leaderboard
  // section: the chart legend chips also expose buttons named after the rubric
  // ("Focus …", "Hide … from chart") earlier in the DOM.
  const rubricRow = leaderboard
    .getByRole("button", { name: new RegExp(RUBRIC_SUPPORT) })
    .first();
  await expect(rubricRow).toBeVisible();

  await rubricRow.getByTestId("score-tooltip-trigger").hover();

  // Tooltip should appear with criteria names.
  const tooltip = page.getByRole("tooltip").first();
  await expect(tooltip).toBeVisible({ timeout: 3000 });
});

test("recent runs feed score shows criteria tooltip on hover", async ({ page }) => {
  await page.goto("/dashboard");

  const recentRuns = page.locator("section", {
    has: page.getByRole("heading", { name: "Recent runs" }),
  });
  await expect(recentRuns).toBeVisible();

  // Find a completed run score in the feed (has a score percentage).
  const scoreEl = recentRuns
    .getByTestId("score-tooltip-trigger")
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
