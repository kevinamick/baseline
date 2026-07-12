import { test, expect, type Page } from "./fixtures";
import {
  CONTRIBUTOR_C,
  CONTRIBUTOR_D,
  TEAM_C_CONNECTION_NAME,
  TEAM_D_CONNECTION_NAME,
  makeAdminClient,
  readSeed,
} from "./constants";

/**
 * Live BYO model listing in the optimization wizard (#485), against the static provider-models
 * mock (e2e/provider-models-mock-server.mjs) the app reaches via the *_API_BASE_OVERRIDE env
 * vars (playwright.config.ts). Team D is the BYO paid fixture: a Builder Team holding BYO
 * OpenAI + Mistral keys. The mock's behavior is fixed for the whole run:
 *   - OpenAI list → 200 with one extra chat model + non-chat noise (success path)
 *   - Mistral list → 500 (failure path: curated-only, no user-facing error)
 * Team C (paid, deliberately keyless → managed mode on every provider) must never see the
 * extra model even while the mock serves it.
 */

// Serial: the run-creating test occupies Team D's single active-run slot, and its cleanup
// (marking stale runs failed) must not race the read-only wizard walk in the first test.
test.describe.configure({ mode: "serial" });

const LIVE_MODEL = "gpt-5.3-preview";
const LIVE_OPTION_LABEL = `${LIVE_MODEL} (latest from provider)`;
// The curated registry's Mistral entries (src/lib/optimization/models.ts REFLECT_MODELS).
const CURATED_MISTRAL_LABELS = ["Mistral Large — most capable", "Mistral Small — fast"];

// Walk the wizard to the Tuning step's Advanced settings (reflective mode over the Team's
// seeded agent Connection, preselected), leaving the "Reflection model" select visible.
async function openReflectionModelSelect(page: Page, connectionName: string) {
  await page.goto("/optimizations");
  await page.getByRole("button", { name: "+ New run" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New optimization run" })).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click(); // Basics → System
  await dialog.getByRole("radio", { name: /Use an existing System/ }).check();
  // The Team's single seeded agent Connection is the preselected option.
  await expect(dialog.getByLabel("Agent connection")).toContainText(connectionName);
  await dialog.getByRole("button", { name: "Next" }).click(); // System → Instances
  await dialog.getByPlaceholder(/User input/).fill("How do I reset my password?");
  await dialog.getByRole("button", { name: "Next" }).click(); // Instances → Tuning
  await dialog.getByRole("button", { name: "Advanced settings" }).click();
  const select = dialog.getByLabel("Reflection model");
  await expect(select).toBeVisible();
  return { dialog, select };
}

test.describe("BYO Team (Team D): live model listing", () => {
  test.use({ storageState: CONTRIBUTOR_D.storageState });

  test("appends the provider's live model to its optgroup; a failed provider stays curated-only with no error", async ({
    page,
  }) => {
    const { dialog, select } = await openReflectionModelSelect(page, TEAM_D_CONNECTION_NAME);

    // Success path: the extra OpenAI model rides its optgroup, labeled as the raw id + marker.
    const openaiOptions = await select
      .locator('optgroup[label="OpenAI"] option')
      .allTextContents();
    expect(openaiOptions).toContain(LIVE_OPTION_LABEL);

    // The shared chat-capable filter kept the mock's non-chat noise out.
    const allOptions = await select.locator("option").allTextContents();
    for (const noise of ["whisper-1", "gpt-4o-audio-preview", "text-embedding-3-small", "gpt-image-1"]) {
      expect(allOptions.join("\n")).not.toContain(noise);
    }
    // The curated gpt-5 entry is not duplicated by its live-list appearance.
    expect(await select.locator('option[value="gpt-5"]').count()).toBe(1);

    // Failure path: the Mistral listing 500s, so its optgroup is exactly the curated list and
    // the wizard surfaces no error anywhere.
    const mistralOptions = await select
      .locator('optgroup[label="Mistral"] option')
      .allTextContents();
    expect(mistralOptions).toEqual(CURATED_MISTRAL_LABELS);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  test("selecting the live model creates a run that stores model + provider", async ({ page }) => {
    const db = makeAdminClient();
    test.skip(!db, "needs the local Supabase env");
    const { teamDOrgId } = readSeed();

    // Retry/order safety: free Team D's single active-run slot before starting.
    await db!
      .from("optimization_runs")
      .update({ status: "failed", error_message: "e2e cleanup (live-models spec)" })
      .eq("org_id", teamDOrgId)
      .in("status", ["queued", "running", "paused"]);

    const { dialog, select } = await openReflectionModelSelect(page, TEAM_D_CONNECTION_NAME);
    await select.selectOption(LIVE_MODEL);
    // The key note names the live model's real provider (group-aware, not the registry fallback).
    await expect(dialog.getByText("Runs on your OpenAI key")).toBeVisible();

    await dialog.getByRole("button", { name: "Next" }).click(); // Tuning → Review
    await expect(dialog.getByText(LIVE_MODEL)).toBeVisible(); // Review names the raw id
    await dialog.getByRole("button", { name: "Start run" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The created run carries the live model AND its validated provider (#485) — the worker's
    // key resolution reads reflect_provider, so this is the no-Anthropic-misroute guarantee.
    await expect
      .poll(
        async () => {
          const { data } = await db!
            .from("optimization_runs")
            .select("reflect_model, reflect_provider")
            .eq("org_id", teamDOrgId)
            .order("created_at", { ascending: false })
            .limit(1);
          return data?.[0] ?? null;
        },
        { timeout: 10_000 },
      )
      .toEqual({ reflect_model: LIVE_MODEL, reflect_provider: "openai" });
  });
});

test.describe("managed-mode Team (Team C): curated only", () => {
  test.use({ storageState: CONTRIBUTOR_C.storageState });

  test("never sees the live model, even while the mock serves it", async ({ page }) => {
    const { select } = await openReflectionModelSelect(page, TEAM_C_CONNECTION_NAME);

    // Team C has no BYO OpenAI key (managed mode) — its OpenAI optgroup stays curated-only.
    const openaiOptions = await select
      .locator('optgroup[label="OpenAI"] option')
      .allTextContents();
    expect(openaiOptions.join("\n")).not.toContain(LIVE_MODEL);
    expect(openaiOptions.length).toBeGreaterThan(0);
  });
});
