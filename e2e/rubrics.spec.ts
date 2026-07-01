import { test, expect } from "./fixtures";
import {
  CONTRIBUTOR_A,
  RUBRIC_SALES,
  RUBRIC_SUPPORT,
  readSeed,
} from "./constants";

const TEMPLATE_NAMES = [
  "Customer Support Standard",
  "Sales Tone Verification",
  "Conversational AI Quality",
  "Content Quality",
];

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

// ── Onboarding / template picker ────────────────────────────────────────────

test("opening the create dialog shows the template picker, not a blank form", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: "New" }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("Start with a template or build your own from scratch."),
  ).toBeVisible();
  // Form fields must not be visible yet.
  await expect(page.getByLabel(/^name$/i)).not.toBeVisible();
});

test("template picker shows all expected template cards", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: "New" }).click();

  for (const name of TEMPLATE_NAMES) {
    await expect(page.getByText(name).first()).toBeVisible();
  }
});

test("'Start from scratch' advances to a blank form", async ({ page }) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: "New" }).click();

  await page.getByRole("button", { name: /start from scratch/i }).click();

  // The rubric name input has a unique placeholder.
  const nameInput = page.getByPlaceholder("e.g. Customer support quality");
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue("");
  await expect(
    page.getByRole("button", { name: /create rubric/i }),
  ).toBeVisible();
});

test("selecting a template pre-fills the form with its data", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: "New" }).click();

  await page.getByText("Customer Support Standard").click();

  await expect(
    page.getByPlaceholder("e.g. Customer support quality"),
  ).toHaveValue("Customer Support Standard");
  await expect(
    page.getByRole("button", { name: /create rubric/i }),
  ).toBeVisible();
  // The "Accuracy" criterion from the template should pre-fill the first
  // criterion's name field.
  await expect(page.getByPlaceholder("e.g. Accuracy").first()).toHaveValue(
    "Accuracy",
  );
});

test("the Back button on the form step returns to the template picker", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page.getByRole("button", { name: "New" }).click();

  await page.getByRole("button", { name: /start from scratch/i }).click();
  await expect(
    page.getByPlaceholder("e.g. Customer support quality"),
  ).toBeVisible();

  await page.getByRole("button", { name: /back/i }).click();

  await expect(
    page.getByText("Start with a template or build your own from scratch."),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("e.g. Customer support quality"),
  ).not.toBeVisible();
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
