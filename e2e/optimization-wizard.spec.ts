import { test, expect, type Page } from "@playwright/test";
import { CONTRIBUTOR_C, TEAM_C_CONNECTION_NAME, TEAM_C_RUBRIC_NAME } from "./constants";

// Team C: the seeded Builder team — the wizard is gated for Free teams (#181).
test.use({ storageState: CONTRIBUTOR_C.storageState });

// Team C's seeded agent connection; the team has no active run, so the "+ New run"
// control is a live button and the wizard opens.
const SEED_CONNECTION = TEAM_C_CONNECTION_NAME;

// The shell marks the active step's <li> with aria-current="step"; assert the breadcrumb
// reflects progress as we move. (The active pill's text also includes the aria-hidden "·"
// separator, so match by substring.)
function activeStep(page: Page) {
  return page.locator('ol[aria-label="Steps"] li[aria-current="step"]');
}

// NOTE: this spec deliberately stops at Review without clicking "Start run". Firing a run
// would consume the org's single active-run slot (a partial unique index enforces one at a
// time) and depends on the Temporal worker, which the e2e stack doesn't run — so a real
// submit would orphan a queued run, flip "+ New run" to a disabled state, and make this
// test order-dependent / flaky on CI retries. The wizard's step navigation, per-step
// validation, and Review summary — the gap we're closing — are all exercised short of that.
test("optimization wizard steps through every step to Review", async ({
  page,
}) => {
  await page.goto("/optimizations");
  await page.getByRole("button", { name: "+ New run" }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "New optimization run" }),
  ).toBeVisible();
  await expect(activeStep(page)).toContainText("Basics");

  // Basics — pick the seeded rubric so the Review summary is deterministic.
  await dialog.getByLabel("Rubric").selectOption({ label: TEAM_C_RUBRIC_NAME });
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("System");

  // System — the seeded agent connection is preselected in "Use existing" mode.
  await expect(dialog.getByLabel("Agent connection")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Instances");

  // Instances — advancing with the default empty row trips per-step validation.
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Add at least one input row.");
  await expect(activeStep(page)).toContainText("Instances");

  // Fill one input row, then advance.
  await dialog
    .getByPlaceholder(/User input/)
    .fill("How do I reset my password?");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Tuning");

  // Back navigation returns to Instances with the typed value preserved.
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(activeStep(page)).toContainText("Instances");
  await expect(dialog.getByPlaceholder(/User input/)).toHaveValue(
    "How do I reset my password?",
  );
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Tuning");

  // Tuning — keep the default rollout budget (30) and advance to Review.
  await expect(dialog.getByLabel("Rollout budget")).toHaveValue("30");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Review");

  // Review reflects every choice, and the submit affordance is present (we don't fire it).
  await expect(dialog.getByText(TEAM_C_RUBRIC_NAME)).toBeVisible();
  await expect(dialog.getByText(SEED_CONNECTION)).toBeVisible();
  await expect(dialog.getByText("1 row")).toBeVisible();
  await expect(dialog.getByText("30 agent calls")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start run" })).toBeVisible();

  // Close without starting a run (see the note above).
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});
