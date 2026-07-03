import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A, RUBRIC_SUPPORT, SCHEDULE_NAME, makeAdminClient, readSeed } from "./constants";

// Schedule pause/resume/delete lifecycle. Mirrors the wizard steps schedule-wizard.spec.ts
// already exercises for creation, then drives the enabled Switch and the delete control from
// schedules-layout.tsx. Every schedule this spec creates carries this unique name so the
// afterAll admin-client backstop can find it without ever touching the seeded
// "Support agent — nightly (seed)" schedule.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const SCHEDULE_NAME_LOCAL = `E2E lifecycle schedule ${RUN_ID}`;

test.use({ storageState: CONTRIBUTOR_A.storageState });

// Serial: keeps the create/pause/delete walk and the seed-guard read deterministic under
// fullyParallel scheduling.
test.describe.configure({ mode: "serial" });

// The seeded schedule's on-screen name. constants.ts says "Support agent — nightly (seed)", but
// a locally stale seed can predate the "(seed)" suffix — match the stable stem so this READ-ONLY
// guard doesn't false-fail against an older local seed. (Nothing here ever mutates it.)
const SEED_SCHEDULE_STEM = /Support agent — nightly/;

test.describe("schedule lifecycle (Contributor)", () => {
  test.afterAll(async () => {
    const db = makeAdminClient();
    if (!db) return;
    const { teamAOrgId } = readSeed();
    // This run's row by its worker-unique name (safe while a retry runs elsewhere),
    // then an age-scoped sweep for crashed prior runs — an unscoped prefix delete
    // from one worker's teardown would race a retrying worker's fresh row.
    await db
      .from("schedules")
      .delete()
      .eq("org_id", teamAOrgId)
      .eq("name", SCHEDULE_NAME_LOCAL);
    await db
      .from("schedules")
      .delete()
      .eq("org_id", teamAOrgId)
      .ilike("name", "E2E lifecycle schedule%")
      .lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  });

  test("create, pause, resume, then delete a scratch schedule", async ({ page }) => {
    // The seeded schedule must never be touched by this spec's pause/delete actions.
    expect(SCHEDULE_NAME_LOCAL).not.toBe(SCHEDULE_NAME);

    await page.goto("/schedules");
    await page.getByRole("button", { name: "New" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "New schedule" }),
    ).toBeVisible();

    // Basics.
    await dialog.getByLabel("Name", { exact: true }).fill(SCHEDULE_NAME_LOCAL);
    await dialog.getByLabel("Rubric").selectOption({ label: RUBRIC_SUPPORT });
    await dialog.getByRole("button", { name: "Next" }).click();

    // System — the seeded agent connection is preselected in "Use existing" mode.
    await expect(dialog.getByLabel("System connection")).toBeVisible();
    await dialog.getByRole("button", { name: "Next" }).click();

    // Inputs (agent flow) — one fixed input row.
    await dialog.getByPlaceholder(/User input/).fill("How do I reset my password?");
    await dialog.getByRole("button", { name: "Next" }).click();

    // Cadence — keep the defaults.
    await dialog.getByRole("button", { name: "Next" }).click();
    // Notify — leave recipients empty, keep enabled, advance to Review.
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByText(SCHEDULE_NAME_LOCAL)).toBeVisible();

    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText(SCHEDULE_NAME_LOCAL).first()).toBeVisible();

    // Select it to open the detail pane.
    await page.getByText(SCHEDULE_NAME_LOCAL).first().click();
    await expect(
      page.getByRole("heading", { name: SCHEDULE_NAME_LOCAL }),
    ).toBeVisible();

    const enabledSwitch = page.getByRole("switch", { name: "Enabled" });
    // A freshly created schedule is enabled by default (the wizard's Notify step default).
    await expect(enabledSwitch).toHaveAttribute("aria-checked", "true");
    const listRow = page.locator("button", { hasText: SCHEDULE_NAME_LOCAL });
    await expect(listRow).toContainText("On");

    // A revalidation-driven re-render can replace the switch between Playwright's
    // actionability check and the click, silently swallowing it — re-click until the
    // state actually flips. The inner timeout is generous enough that a registered
    // click's server round-trip lands before a retry could double-toggle.
    const toggleTo = async (checked: "true" | "false") => {
      await expect(async () => {
        await enabledSwitch.click();
        await expect(enabledSwitch).toHaveAttribute("aria-checked", checked, {
          timeout: 5_000,
        });
      }).toPass();
    };

    // Pause.
    await toggleTo("false");
    await expect(listRow).toContainText("Off");

    // Resume.
    await toggleTo("true");
    await expect(listRow).toContainText("On");

    // Delete — the control uses a native window.confirm(); accept it. Same re-render
    // fragility as the toggle above: a swallowed click leaves the row behind (and can
    // clear the detail-pane selection), so retry the whole select→delete interaction
    // until the row is actually gone.
    await expect(async () => {
      if ((await listRow.count()) > 0) {
        const deleteButton = page.getByRole("button", { name: "Delete schedule" });
        if (!(await deleteButton.isVisible())) {
          await page.getByText(SCHEDULE_NAME_LOCAL).first().click();
        }
        page.once("dialog", (d) => d.accept());
        await deleteButton.click();
      }
      await expect(page.getByText(SCHEDULE_NAME_LOCAL)).toHaveCount(0, {
        timeout: 5_000,
      });
    }).toPass();
  });

  test("the seeded schedule is untouched: still listed and openable", async ({ page }) => {
    // Read-only guard that the lifecycle walk above never brushed the seed: it is still in the
    // list and its detail opens. It is never toggled or deleted here; the enabled Switch's live
    // state is whatever the seed/other read-only specs left it, so no state assertion beyond
    // "still present, still openable".
    await page.goto("/schedules");
    await page.getByText(SEED_SCHEDULE_STEM).first().click();
    await expect(
      page.getByRole("heading", { name: SEED_SCHEDULE_STEM }),
    ).toBeVisible();
  });
});
