import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A, RUBRIC_SUPPORT } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

const SEED_RUN_DESCRIPTION = `${RUBRIC_SUPPORT} — seeded run`;

test("selecting a rubric lists its seeded eval runs", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await expect(page.getByRole("heading", { name: "Eval runs" })).toBeVisible();
  await expect(page.getByText(SEED_RUN_DESCRIPTION).first()).toBeVisible();
});

test("opening a completed run shows its scoring detail", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await page.getByText(SEED_RUN_DESCRIPTION).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Run detail")).toBeVisible();
  // The summary tiles + per-row breakdown render from the seeded results.
  await expect(dialog.getByText("Overall")).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Per-row breakdown" }),
  ).toBeVisible();
  // Expanding a row reveals its per-criterion scores.
  await dialog.getByRole("button", { name: /^Row 1/ }).click();
  await expect(dialog.getByText("Accuracy").first()).toBeVisible();
});

test("hovering a completed run score shows criteria tooltip", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await expect(page.getByText(SEED_RUN_DESCRIPTION).first()).toBeVisible();

  // Hover over the score wrapper (div.relative) within the seeded run row.
  const runRow = page
    .getByRole("button", { name: new RegExp(SEED_RUN_DESCRIPTION) })
    .first();
  await expect(runRow).toBeVisible();

  const scoreWrapper = runRow.locator("div.relative").first();
  await scoreWrapper.hover();

  // Tooltip should load with criteria breakdown (server-fetched).
  const tooltip = page.getByRole("tooltip").first();
  await expect(tooltip).toBeVisible({ timeout: 5000 });
  // The seeded rubric has "Accuracy" as a criterion.
  await expect(tooltip.getByText("Accuracy")).toBeVisible();
});
