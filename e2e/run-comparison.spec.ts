import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A, RUBRIC_SUPPORT } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test("Compare button appears when a rubric has 2+ completed runs", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await expect(page.getByRole("heading", { name: "Eval runs" })).toBeVisible();
  // The seeded rubric has 5 completed runs, so Compare should be available.
  await expect(
    page.getByRole("button", { name: "Compare" })
  ).toBeVisible();
});

test("Entering compare mode changes the header and makes runs selectable", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await page.getByRole("button", { name: "Compare" }).click();

  // Header should now prompt selection.
  await expect(page.getByText("Select 2 runs")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel" })
  ).toBeVisible();
});

test("Selecting 2 runs enables the Compare button and opens the comparison modal", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  // Enter compare mode.
  await page.getByRole("button", { name: "Compare" }).click();

  // Select the first two available runs (the seeded description matches the pattern).
  const runButtons = page.getByRole("button", { name: /Support reply quality/ });
  await runButtons.nth(0).click();
  await runButtons.nth(1).click();

  await expect(page.getByText("2 runs selected")).toBeVisible();

  // The Compare button in the header (inside compare mode) should be enabled.
  const compareActionButton = page.getByRole("button", { name: "Compare" }).last();
  await expect(compareActionButton).toBeVisible();
  await compareActionButton.click();

  // The comparison modal should open.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Run comparison")).toBeVisible();
  await expect(dialog.getByText("Regression analysis")).toBeVisible();
});

test("Comparison modal shows per-criterion table", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await page.getByRole("button", { name: "Compare" }).click();
  const runButtons = page.getByRole("button", { name: /Support reply quality/ });
  await runButtons.nth(0).click();
  await runButtons.nth(1).click();
  await page.getByRole("button", { name: "Compare" }).last().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Wait for comparison data to load (the server action call resolves).
  await expect(dialog.getByText("Criterion")).toBeVisible();
  // The seeded rubric has Accuracy, Completeness, Tone criteria.
  await expect(dialog.getByText("Accuracy")).toBeVisible();
});

test("Comparison modal shows per-row breakdown", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await page.getByRole("button", { name: "Compare" }).click();
  const runButtons = page.getByRole("button", { name: /Support reply quality/ });
  await runButtons.nth(0).click();
  await runButtons.nth(1).click();
  await page.getByRole("button", { name: "Compare" }).last().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Per-row breakdown")).toBeVisible();

  // Expand Row 1.
  await dialog.getByRole("button", { name: /^Row 1/ }).click();
  await expect(dialog.getByText("User input")).toBeVisible();
  await expect(dialog.getByText("Run A output")).toBeVisible();
  await expect(dialog.getByText("Run B output")).toBeVisible();
});

test("Cancelling compare mode restores the normal header", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.getByText("Select 2 runs")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Eval runs" })).toBeVisible();
});

test("Comparison modal can be closed", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();

  await page.getByRole("button", { name: "Compare" }).click();
  const runButtons = page.getByRole("button", { name: /Support reply quality/ });
  await runButtons.nth(0).click();
  await runButtons.nth(1).click();
  await page.getByRole("button", { name: "Compare" }).last().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
});
