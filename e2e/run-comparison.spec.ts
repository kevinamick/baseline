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
  const runButtons = page.getByRole("button", { name: /seeded run/ });
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
  const runButtons = page.getByRole("button", { name: /seeded run/ });
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
  const runButtons = page.getByRole("button", { name: /seeded run/ });
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
  const runButtons = page.getByRole("button", { name: /seeded run/ });
  await runButtons.nth(0).click();
  await runButtons.nth(1).click();
  await page.getByRole("button", { name: "Compare" }).last().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Two controls are named "Close" — the header icon button (aria-label) and the
  // footer button. Use the footer one explicitly.
  await dialog.getByRole("button", { name: "Close" }).last().click();
  await expect(dialog).not.toBeVisible();
});

// ── Selection logic & modal detail (additional coverage) ─────────────────────

// Enter compare mode on the seeded support rubric and click the first `count`
// run rows. Returns the run-row locator so callers can toggle further.
async function enterCompareAndSelect(
  page: import("@playwright/test").Page,
  count: number
) {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
  await page.getByRole("button", { name: "Compare" }).click();
  const runButtons = page.getByRole("button", {
    name: /seeded run/,
  });
  for (let i = 0; i < count; i++) await runButtons.nth(i).click();
  return runButtons;
}

// Select two runs and open the comparison modal; returns the dialog locator.
async function openComparison(page: import("@playwright/test").Page) {
  await enterCompareAndSelect(page, 2);
  await page.getByRole("button", { name: "Compare" }).last().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("selecting one run prompts for one more and hides the Compare action", async ({
  page,
}) => {
  await enterCompareAndSelect(page, 1);

  await expect(page.getByText("Select 1 more")).toBeVisible();
  // The in-mode Compare action only appears once exactly two runs are selected.
  await expect(page.getByRole("button", { name: "Compare" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("deselecting a run reverts the selection prompt", async ({ page }) => {
  const runButtons = await enterCompareAndSelect(page, 2);
  await expect(page.getByText("2 runs selected")).toBeVisible();

  // Toggling a selected run off drops the count back to one.
  await runButtons.nth(0).click();
  await expect(page.getByText("Select 1 more")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare" })).toHaveCount(0);
});

test("selecting a third run replaces the oldest, keeping two selected", async ({
  page,
}) => {
  // Selection is capped at two — a third pick swaps out the oldest, so the
  // prompt stays at "2 runs selected" and Compare remains available.
  await enterCompareAndSelect(page, 3);

  await expect(page.getByText("2 runs selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare" })).toBeVisible();
});

test("comparison modal includes a Run A / Run B / Delta criterion table", async ({
  page,
}) => {
  const dialog = await openComparison(page);

  // Column headers — "Run A"/"Run B" here are the per-criterion table headers
  // (the score tiles render the run descriptions, not these labels).
  await expect(dialog.getByText("Run A", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Run B", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Delta")).toBeVisible();
});

test("comparison modal closes on Escape", async ({ page }) => {
  const dialog = await openComparison(page);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("comparison modal footer shows the two run ids", async ({ page }) => {
  const dialog = await openComparison(page);

  // Footer renders "<runIdA> vs <runIdB>".
  await expect(dialog.getByText("vs", { exact: true })).toBeVisible();
});

test("expanding then collapsing a per-row breakdown toggles its detail", async ({
  page,
}) => {
  const dialog = await openComparison(page);
  await expect(dialog.getByText("Per-row breakdown")).toBeVisible();

  const row1 = dialog.getByRole("button", { name: /^Row 1/ });
  await row1.click();
  await expect(dialog.getByText("User input")).toBeVisible();

  // Clicking the row again collapses it.
  await row1.click();
  await expect(dialog.getByText("User input")).not.toBeVisible();
});
