import { test, expect } from "@playwright/test";
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
  // The "Accuracy" criterion from the template should appear.
  await expect(page.getByDisplayValue("Accuracy")).toBeVisible();
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
