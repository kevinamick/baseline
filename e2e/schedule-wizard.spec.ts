import { test, expect, type Page } from "@playwright/test";
import { CONTRIBUTOR_A, RUBRIC_SUPPORT } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

// The seed creates an agent connection ("Acme support agent (seed)"). Picking it in
// "Use existing" mode keeps the wizard on the agent flow (which includes the Inputs step).
const SEED_CONNECTION = "Acme support agent (seed)";

// A distinct, recognizable artifact name. createSchedule has no unique-name constraint and
// the seed wipes prior data on each run, so a fixed name is safe (a CI retry that re-creates
// it just leaves a harmless duplicate the .first() assertion still matches).
const NEW_SCHEDULE_NAME = "E2E wizard — created schedule";

function activeStep(page: Page) {
  return page.locator('ol[aria-label="Steps"] li[aria-current="step"]');
}

// Unlike the optimization run, creating a schedule is a plain DB insert (no active-run slot,
// no worker dependency), so this spec drives the full agent flow AND submits, then asserts
// the new schedule appears in the list.
test("schedule wizard creates a schedule end to end", async ({ page }) => {
  await page.goto("/schedules");
  await page.getByRole("button", { name: "New" }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "New schedule" }),
  ).toBeVisible();
  await expect(activeStep(page)).toContainText("Basics");

  // Basics — advancing without a name trips per-step validation.
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the schedule a name.");
  await expect(activeStep(page)).toContainText("Basics");

  await dialog.getByLabel("Name", { exact: true }).fill(NEW_SCHEDULE_NAME);
  await dialog.getByLabel("Rubric").selectOption({ label: RUBRIC_SUPPORT });
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("System");

  // System — the seeded agent connection is preselected in "Use existing" mode.
  await expect(dialog.getByLabel("System connection")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Inputs");

  // Inputs (agent flow only) — one fixed input row.
  await dialog.getByPlaceholder(/User input/).fill("How do I reset my password?");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Cadence");

  // Cadence — keep the defaults (daily at 09:00).
  await expect(dialog.getByLabel("Frequency")).toHaveValue("daily");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Notify");

  // Notify — leave recipients empty, keep enabled, advance to Review.
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(activeStep(page)).toContainText("Review");

  // Review reflects the choices.
  await expect(dialog.getByText(NEW_SCHEDULE_NAME)).toBeVisible();
  await expect(dialog.getByText(SEED_CONNECTION)).toBeVisible();
  await expect(dialog.getByText(/Daily at 09:00/)).toBeVisible();

  // Submit — the dialog closes and the new schedule shows up in the list.
  await dialog.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(NEW_SCHEDULE_NAME).first()).toBeVisible();
});
