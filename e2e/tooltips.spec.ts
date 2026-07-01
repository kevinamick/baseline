import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test.describe("Rubric dialog tooltips", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // The dialog opens on the template picker; drop into the empty form.
    await page.getByText("Start from scratch").click();
    await expect(
      page.getByPlaceholder("e.g. Customer support quality"),
    ).toBeVisible();
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

  test("top-most field tooltip is not clipped by the dialog body", async ({
    page,
  }) => {
    // The evaluation mode field is the first field with a tooltip, sitting at
    // the top of the scrollable dialog body. Its tooltip must flip below rather
    // than open upward and get clipped by the scroll container's top edge.
    const evalModeLabel = page.getByText("Evaluation mode");
    const infoBtn = evalModeLabel
      .locator("..")
      .getByRole("button", { name: "More information" });
    await infoBtn.hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();

    const tooltipBox = await tooltip.boundingBox();
    const dialogBox = await page.getByRole("dialog").boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(dialogBox).not.toBeNull();
    // The whole tooltip must sit within the dialog's vertical bounds.
    expect(tooltipBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
    expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(
      dialogBox!.y + dialogBox!.height,
    );
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
    // The dialog opens on the template picker; drop into the empty form.
    await page.getByText("Start from scratch").click();
    await expect(
      page.getByPlaceholder("e.g. Customer support quality"),
    ).toBeVisible();
  });

  test("weight field has an info tooltip", async ({ page }) => {
    const weightLabel = page.getByText("Weight", { exact: true }).first();
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

  test("weight tooltip stays within the dialog and creates no horizontal scroll", async ({
    page,
  }) => {
    // The weight field sits in a narrow column near the dialog's right edge.
    // Its fixed-width tooltip must clamp inside the dialog rather than overflow
    // sideways and produce a horizontal scrollbar on the dialog body.
    const weightLabel = page.getByText("Weight", { exact: true }).first();
    const infoBtn = weightLabel
      .locator("..")
      .getByRole("button", { name: "More information" });

    // Open, close, then reopen: the clamp must hold on repeat hovers too — a
    // persisted offset must not drift the tooltip back into overflow.
    await infoBtn.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.getByRole("heading", { name: "Criteria" }).hover();
    await expect(page.getByRole("tooltip")).toBeHidden();
    await infoBtn.hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();

    const tooltipBox = await tooltip.boundingBox();
    const dialogBox = await page.getByRole("dialog").boundingBox();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(
      dialogBox!.x + dialogBox!.width,
    );

    // The page itself must not gain a horizontal scrollbar.
    const hasXScroll = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth > el.clientWidth + 1;
    });
    expect(hasXScroll).toBe(false);
  });

  test("hovering weight info button shows weight tooltip", async ({ page }) => {
    const weightLabel = page.getByText("Weight", { exact: true }).first();
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
