import { test, expect } from "@playwright/test";
import {
  CONTRIBUTOR_A,
  RUBRIC_SALES,
  RUBRIC_SUPPORT,
  readSeed,
} from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test("rubrics list shows the seeded rubrics", async ({ page }) => {
  await page.goto("/rubrics");
  // Page title is an sr-only <h1>Rubrics</h1>; the panel also has an <h2>Rubrics</h2>.
  await expect(
    page.getByRole("heading", { name: "Rubrics" }).first(),
  ).toBeVisible();
  await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
  await expect(page.getByText(RUBRIC_SALES).first()).toBeVisible();
});

test("a Contributor sees the create control", async ({ page }) => {
  await page.goto("/rubrics");
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});

test("opening the create dialog reveals the rubric form", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: "New" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel(/name/i).first()).toBeVisible();
});

test("selecting a rubric exposes the Run eval control", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
  await expect(page.getByRole("button", { name: "Run eval" })).toBeVisible();
});

test("the rubric detail route renders the rubric and its criteria", async ({
  page,
}) => {
  const { teamARubricId } = readSeed();
  await page.goto(`/rubrics/${teamARubricId}`);
  await expect(
    page.getByRole("heading", { name: RUBRIC_SUPPORT }),
  ).toBeVisible();
  // Seeded criterion of "Support reply quality".
  await expect(page.getByText("Accuracy").first()).toBeVisible();
});

// --- Search / filter controls ---

test("the search input is visible on the rubrics page", async ({ page }) => {
  await page.goto("/rubrics");
  await expect(
    page.getByRole("textbox", { name: /filter rubrics by name/i }),
  ).toBeVisible();
});

test("the sort select is visible on the rubrics page", async ({ page }) => {
  await page.goto("/rubrics");
  await expect(
    page.getByRole("combobox", { name: /sort rubrics/i }),
  ).toBeVisible();
});

test("typing in the filter hides non-matching rubrics", async ({ page }) => {
  await page.goto("/rubrics");

  // Both rubrics are visible initially.
  await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
  await expect(page.getByText(RUBRIC_SALES).first()).toBeVisible();

  // Filter to only the support rubric.
  await page.getByRole("textbox", { name: /filter rubrics by name/i }).fill("support");

  await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
  await expect(page.getByText(RUBRIC_SALES)).toHaveCount(0);
});

test("clearing the filter with the X button restores all rubrics", async ({
  page,
}) => {
  await page.goto("/rubrics");

  await page.getByRole("textbox", { name: /filter rubrics by name/i }).fill("support");
  await expect(page.getByText(RUBRIC_SALES)).toHaveCount(0);

  await page.getByRole("button", { name: /clear filter/i }).click();

  await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
  await expect(page.getByText(RUBRIC_SALES).first()).toBeVisible();
});

test("an unmatched filter query shows the no-results message", async ({
  page,
}) => {
  await page.goto("/rubrics");

  await page
    .getByRole("textbox", { name: /filter rubrics by name/i })
    .fill("zzznomatch");

  await expect(page.getByText(/no rubrics match your filter/i)).toBeVisible();
});

test("changing sort order to A–Z reorders the rubrics list", async ({
  page,
}) => {
  await page.goto("/rubrics");

  await page
    .getByRole("combobox", { name: /sort rubrics/i })
    .selectOption("name");

  // Both seeded rubrics are present; "Sales" precedes "Support" alphabetically.
  const items = page.getByRole("listitem");
  const firstItem = items.first();
  const lastItem = items.last();
  await expect(firstItem).toContainText("Sales");
  await expect(lastItem).toContainText("Support");
});

// --- KPI summary cards (#168) ---

test("KPI summary cards are visible on the rubrics page", async ({ page }) => {
  await page.goto("/rubrics");

  await expect(page.getByTestId("kpi-rubrics")).toBeVisible();
  await expect(page.getByTestId("kpi-eval-runs")).toBeVisible();
  await expect(page.getByTestId("kpi-avg-score")).toBeVisible();
});

test("KPI cards show correct labels", async ({ page }) => {
  await page.goto("/rubrics");

  await expect(page.getByTestId("kpi-rubrics")).toContainText("Rubrics");
  await expect(page.getByTestId("kpi-eval-runs")).toContainText("Eval runs");
  await expect(page.getByTestId("kpi-avg-score")).toContainText("Avg score");
});

test("KPI rubrics card shows the seeded rubric count", async ({ page }) => {
  await page.goto("/rubrics");

  // Team A has two seeded rubrics (RUBRIC_SUPPORT and RUBRIC_SALES).
  await expect(page.getByTestId("kpi-rubrics")).toContainText("2");
});
