import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test.describe("Rubric dialog tooltips", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("evaluation mode field has an info tooltip", async ({ page }) => {
    const evalModeLabel = page.getByText("Evaluation mode");
    const infoBtn = evalModeLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("hovering evaluation mode info button shows tooltip content", async ({
    page,
  }) => {
    const evalModeLabel = page.getByText("Evaluation mode");
    const infoBtn = evalModeLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await infoBtn.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Prompt / Response");
    await expect(tooltip).toContainText("Conversational");
  });

  test("grounding context field has an info tooltip", async ({ page }) => {
    const groundingLabel = page.getByText("Grounding context");
    const infoBtn = groundingLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("hovering grounding context info button shows tooltip content", async ({
    page,
  }) => {
    const groundingLabel = page.getByText("Grounding context");
    const infoBtn = groundingLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await infoBtn.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("LLM evaluator");
  });

  test("scenario description field has an info tooltip", async ({ page }) => {
    const label = page.getByText("Scenario description");
    const infoBtn = label
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("expected outcome field has an info tooltip", async ({ page }) => {
    const label = page.getByText("Expected outcome");
    const infoBtn = label
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("tooltip is hidden after moving the mouse away", async ({ page }) => {
    const evalModeLabel = page.getByText("Evaluation mode");
    const infoBtn = evalModeLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await infoBtn.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();

    // Move mouse to a neutral area (the dialog title)
    await page.getByRole("heading", { name: "New rubric" }).hover();
    await expect(page.getByRole("tooltip")).not.toBeVisible();
  });
});

test.describe("Criteria tooltips", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("weight field has an info tooltip", async ({ page }) => {
    const weightLabel = page.getByText("Weight").first();
    const infoBtn = weightLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("scoring steps field has an info tooltip", async ({ page }) => {
    const stepsLabel = page.getByText("Scoring steps");
    const infoBtn = stepsLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("hovering weight info button shows weight tooltip", async ({ page }) => {
    const weightLabel = page.getByText("Weight").first();
    const infoBtn = weightLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await infoBtn.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("1.00");
  });
});

test.describe("Run eval dialog tooltips", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/rubrics");
    // Select a rubric to enable the Run eval button
    const rubricBtn = page.getByRole("button").filter({ hasText: /quality/i }).first();
    await rubricBtn.click();
    await page.getByRole("button", { name: "Run eval" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("eval rubric field has an info tooltip", async ({ page }) => {
    const label = page.getByText("Eval rubric");
    const infoBtn = label
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("evaluation type field has an info tooltip", async ({ page }) => {
    const label = page.getByText("Evaluation type");
    const infoBtn = label
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("input source section has an info tooltip", async ({ page }) => {
    const label = page.getByText("Input source");
    const infoBtn = label
      .locator("..")
      .getByRole("button", { name: "More information" });
    await expect(infoBtn).toBeVisible();
  });

  test("hovering eval rubric info button shows rubric tooltip", async ({
    page,
  }) => {
    const label = page.getByText("Eval rubric");
    const infoBtn = label
      .locator("..")
      .getByRole("button", { name: "More information" });
    await infoBtn.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("rubric");
  });
});
