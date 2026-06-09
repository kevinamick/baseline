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
