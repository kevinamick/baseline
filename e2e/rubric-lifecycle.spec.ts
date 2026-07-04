import { test, expect, expectAfterMutation } from "./fixtures";
import { CONTRIBUTOR_A, RUBRIC_SUPPORT, readSeed, makeAdminClient } from "./constants";

/**
 * Rubric edit/delete lifecycle (#352) + eval-run submission (#123, ADR-0006).
 *
 * Creates and tears down its own SCRATCH rubric on Team A so it never disturbs
 * the seeded rubrics `e2e/rubrics.spec.ts` counts (KPI card asserts exactly 2).
 * The eval-run submission tests reuse the seeded `RUBRIC_SUPPORT` rubric —
 * Team A already carries a BYO Anthropic key from the seed script (#184), so
 * submission is accepted without needing a paid-Team managed-key fallback.
 * The e2e stack runs a Temporal dev server but no worker, so a submitted run
 * stays queued/failed forever — assertions target presence, not completion.
 */

test.use({ storageState: CONTRIBUTOR_A.storageState });

const RUN_TAG = Date.now();
const SCRATCH_NAME = `E2E Scratch Rubric ${RUN_TAG}`;
const RENAMED_NAME = `${SCRATCH_NAME} (renamed)`;
const EVAL_DESCRIPTION = `E2E lifecycle manual run ${RUN_TAG}`;
const EVAL_DESCRIPTION_CSV = `E2E lifecycle CSV run ${RUN_TAG}`;

const db = makeAdminClient();

test.describe("Rubric edit/delete lifecycle (#352)", () => {
  test.skip(!db, "needs the local Supabase env for id lookup + cleanup");
  test.describe.configure({ mode: "serial" });

  let scratchRubricId: string | null = null;

  test.afterAll(async () => {
    // Backstop: if a test failed before the UI delete ran, remove anything this
    // spec created by name so Team A's rubric count returns to what
    // e2e/rubrics.spec.ts expects. This run's rows go by their worker-unique
    // names (safe while a retry runs elsewhere); the generic prefix sweep for
    // crashed prior runs is age-scoped so one worker's teardown can't race a
    // retrying worker's fresh row.
    if (!db) return;
    const { teamAOrgId } = readSeed();
    await db
      .from("rubrics")
      .delete()
      .eq("org_id", teamAOrgId)
      .in("name", [SCRATCH_NAME, RENAMED_NAME]);
    await db
      .from("rubrics")
      .delete()
      .eq("org_id", teamAOrgId)
      .ilike("name", "E2E Scratch Rubric%")
      .lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  });

  test("create a SCRATCH rubric via the UI", async ({ page }) => {
    // Server-action round trips on this shared dev box can run slow under
    // concurrent e2e load from other suites — give this room over the default.
    test.setTimeout(60_000);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("button", { name: /start from scratch/i }).click();

    await page
      .getByPlaceholder("e.g. Customer support quality")
      .fill(SCRATCH_NAME);
    await page
      .getByPlaceholder("Describe the scenario being evaluated…")
      .fill("E2E lifecycle scratch scenario.");
    await page
      .getByPlaceholder("What does a good response look like?")
      .fill("E2E lifecycle expected outcome.");
    await page.getByPlaceholder("e.g. Accuracy").first().fill("Accuracy");
    await page
      .getByPlaceholder("Instruction for the LLM evaluator…")
      .first()
      .fill("Check the answer is accurate.");

    await page.getByRole("button", { name: /create rubric/i }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(SCRATCH_NAME).first()).toBeVisible();

    const { teamAOrgId } = readSeed();
    const { data, error } = await db!
      .from("rubrics")
      .select("id")
      .eq("org_id", teamAOrgId)
      .eq("name", SCRATCH_NAME)
      .single();
    expect(error).toBeNull();
    scratchRubricId = data!.id;
  });

  test("the detail route reflects the freshly created rubric", async ({ page }) => {
    test.skip(!scratchRubricId, "rubric was not created");
    await page.goto(`/rubrics/${scratchRubricId}`);
    await expect(
      page.getByRole("heading", { name: SCRATCH_NAME }),
    ).toBeVisible();
    await expect(page.getByText("Accuracy").first()).toBeVisible();
  });

  test("editor validation shows the inline per-field error on the specific input (#352)", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: SCRATCH_NAME }).click();
    await page
      .locator("li", { hasText: SCRATCH_NAME })
      .getByRole("button", { name: "Edit rubric" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Wait for the edit form to hydrate from getRubric.
    const nameInput = dialog.locator("#criterion-name-0");
    await expect(nameInput).toHaveValue("Accuracy");

    // An out-of-range WEIGHT never reaches the Zod layer in a real browser:
    // the number input's native min="0" max="1" constraint validation blocks
    // the submit first (the form has no noValidate), so nothing is sent and
    // the dialog stays open. No value fails Zod's 0–1 check while passing the
    // native min/max, so the inline weight message is a backstop — covered by
    // rubric-dialog.dom.test.tsx, where submit bypasses native constraint
    // validation. Assert the native gate is what blocks here.
    const weightInput = dialog.locator("#criterion-weight-0");
    await weightInput.fill("2");
    await dialog.getByRole("button", { name: /save changes/i }).click();
    await expect(dialog).toBeVisible();
    expect(
      await weightInput.evaluate(
        (el) => (el as HTMLInputElement).validity.rangeOverflow,
      ),
    ).toBe(true);
    await weightInput.fill("1");

    // The per-field path #352 ships (reconstructed Zod issue paths → inline
    // error + aria-invalid on the SPECIFIC input, not just a section banner)
    // is reachable through a field native validation can't intercept: the
    // criterion name input carries no `required` attribute, so an empty name
    // submits and the client Zod parse attaches the error to that input.
    await nameInput.fill("");
    await dialog.getByRole("button", { name: /save changes/i }).click();

    await expect(nameInput).toHaveAttribute("aria-invalid", "true");
    const criterionCard = dialog.locator("#criterion-card-0");
    await expect(
      criterionCard.getByText("Criterion name is required"),
    ).toBeVisible();
    // Deduped per-field rendering: the message appears once, on the field —
    // not repeated as a section-level banner (#352 strips per-element
    // messages from the section `criteria` key).
    await expect(dialog.getByText("Criterion name is required")).toHaveCount(1);

    // Editing the criterion clears the inline error; back out without saving.
    await nameInput.fill("Accuracy");
    await expect(nameInput).toHaveAttribute("aria-invalid", "false");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("rename, add a criterion + steps, save, and the detail reflects it", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/rubrics");
    await page
      .locator("li", { hasText: SCRATCH_NAME })
      .getByRole("button", { name: "Edit rubric" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.locator("#rubric-name").fill(RENAMED_NAME);

    // Existing criterion keeps half the weight; the new one takes the other half
    // so the total still sums to 1.00 and the save isn't blocked.
    await dialog.locator("#criterion-weight-0").fill("0.5");
    await dialog.getByRole("button", { name: "Add criterion" }).click();
    await dialog.locator("#criterion-name-1").fill("Clarity");
    await dialog.locator("#criterion-weight-1").fill("0.5");
    await dialog
      .locator("#criterion-step-1-0")
      .fill("Check the answer is clear and well organized.");
    await dialog
      .locator("#criterion-card-1")
      .getByRole("button", { name: "+ Add step" })
      .click();
    await dialog
      .locator("#criterion-step-1-1")
      .fill("Check the answer avoids jargon.");

    await dialog.getByRole("button", { name: /save changes/i }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await expectAfterMutation(page, (o) =>
      expect(page.getByText(RENAMED_NAME).first()).toBeVisible(o),
    );

    await page.goto(`/rubrics/${scratchRubricId}`);
    await expect(
      page.getByRole("heading", { name: RENAMED_NAME }),
    ).toBeVisible();
    await expect(page.getByText("Accuracy").first()).toBeVisible();
    await expect(page.getByText("Clarity").first()).toBeVisible();
  });

  test("Esc does not dismiss the delete confirm dialog; Cancel does; confirming removes it", async ({
    page,
  }) => {
    await page.goto("/rubrics");
    await page
      .locator("li", { hasText: RENAMED_NAME })
      .getByRole("button", { name: "Delete rubric" })
      .click();

    const confirmHeading = page.getByRole("heading", { name: "Delete rubric" });
    await expect(confirmHeading).toBeVisible();

    // Esc guardrail (repo convention): must NOT dismiss a destructive confirm.
    await page.keyboard.press("Escape");
    await expect(confirmHeading).toBeVisible();

    // Cancel does dismiss it.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmHeading).toHaveCount(0);

    // Re-open and confirm through the two-press escalation.
    await page
      .locator("li", { hasText: RENAMED_NAME })
      .getByRole("button", { name: "Delete rubric" })
      .click();
    await expect(confirmHeading).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete forever?" }).click();

    // deleteRubric commits, revalidates, and redirects back to /rubrics — but the
    // client can lose the action's 303 flight under CI load (the #406 lost-response
    // race), leaving the confirm dialog open on stale client state. The delete has
    // landed server-side either way; one reload recovers.
    await expectAfterMutation(page, async (o) => {
      await expect(confirmHeading).toHaveCount(0, o);
      await expect(page.getByText(RENAMED_NAME)).toHaveCount(0, o);
    });
    scratchRubricId = null;
  });
});

test.describe("Eval-run submission (#123, ADR-0006)", () => {
  test.afterAll(async () => {
    // Best-effort cleanup of the runs this spec creates on the seeded rubric —
    // no other spec depends on Team A's eval-run count, but keep the fixture tidy.
    // Same retry-safe split as the rubric sweep above.
    if (!db) return;
    const { teamARubricId } = readSeed();
    await db
      .from("eval_runs")
      .delete()
      .eq("rubric_id", teamARubricId)
      .in("description", [EVAL_DESCRIPTION, EVAL_DESCRIPTION_CSV]);
    await db
      .from("eval_runs")
      .delete()
      .eq("rubric_id", teamARubricId)
      .ilike("description", "E2E lifecycle%")
      .lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  });

  test("manual rows submit and a new run appears with any status", async ({ page }) => {
    // Creating a run reserves points/managed spend and starts a durable Temporal
    // workflow — give it room over the default on a loaded dev box.
    test.setTimeout(60_000);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
    await page.getByRole("button", { name: "Run eval" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.locator("#run-eval-description").fill(EVAL_DESCRIPTION);
    await dialog.locator("#user-input-0").fill("Where does this ticket go?");
    await dialog.locator("#agent-output-0").fill("Queue: billing, P2");

    await dialog.getByRole("button", { name: "+ Add row" }).click();
    await dialog
      .locator("#user-input-1")
      .fill("How do I reset my password?");
    await dialog
      .locator("#agent-output-1")
      .fill("Use the Forgot password link on the sign-in page.");

    await dialog.getByRole("button", { name: "Run eval" }).click();

    // Accepted — the dialog closes with no refusal (Team A holds a BYO key).
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // A new run appears in the runs panel, any status (queued/failed both fine —
    // there's no live judging worker in the e2e stack).
    await expect(page.getByText(EVAL_DESCRIPTION).first()).toBeVisible();
  });

  test("CSV upload parses rows before submit", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
    await page.getByRole("button", { name: "Run eval" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.locator("#run-eval-description").fill(EVAL_DESCRIPTION_CSV);
    await dialog.getByRole("tab", { name: "File (CSV)" }).click();

    // Plain fields only — no quoted commas or escaped quotes (that parsing edge
    // is guarded on another branch).
    const csv = [
      "user_input,agent_output,expected_output",
      "Where does this ticket go?,Queue: billing P2,Route to billing",
      "How do I reset my password?,Use the Forgot password link,Reset via email link",
    ].join("\n");

    await dialog.locator('input[aria-label="Upload CSV file"]').setInputFiles({
      name: "eval-rows.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf-8"),
    });

    // Rows parsed client-side before submit.
    await expect(dialog.getByText("2 rows")).toBeVisible();

    await dialog.getByRole("button", { name: "Run eval" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await expect(page.getByText(EVAL_DESCRIPTION_CSV).first()).toBeVisible();
  });
});
