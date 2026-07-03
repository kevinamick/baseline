import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A, makeAdminClient, readSeed } from "./constants";
import { ENDPOINT_INTERNAL_MESSAGE } from "../src/lib/connections/endpoint";

// Connection creation/deletion lifecycle (#39, #119, #220, #353) plus the dataset "Test query"
// preview's SSRF guard. Every scratch connection this spec creates carries this unique prefix so
// the afterAll admin-client backstop can find it without ever touching the seeded
// "Acme support agent (seed)" connection connections.spec.ts already covers.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const CONN_NAME = `E2E scratch dataset ${RUN_ID}`;

test.use({ storageState: CONTRIBUTOR_A.storageState });

// Serial: the create test seeds CONN_NAME, the delete test at the end relies on it still being
// there. fullyParallel scheduling would otherwise run these out of order across workers.
test.describe.configure({ mode: "serial" });

test.describe("connection lifecycle (Contributor)", () => {
  test.afterAll(async () => {
    // Backstop: delete anything this spec's run created but a test failed to clean up itself.
    // Scoped to Team A's org and this run's unique name prefix — never touches the seed.
    const db = makeAdminClient();
    if (!db) return;
    const { teamAOrgId } = readSeed();
    await db
      .from("connections")
      .delete()
      .eq("org_id", teamAOrgId)
      .ilike("name", "E2E scratch dataset%");
  });

  test("creates a custom-dataset connection and it appears in the list with its kind", async ({
    page,
  }) => {
    await page.goto("/settings/connections");
    await page.getByRole("button", { name: "Add connection" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Add connection" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Custom data source" }).click();
    await dialog.getByLabel("Connection name").fill(CONN_NAME);
    // A well-formed public HTTPS endpoint — creation only validates/stores the URL, it never
    // dereferences it, so a non-existent host is fine here (unlike the preview test below).
    await dialog.getByLabel("Endpoint URL").fill("https://api.example.com/logs");

    await dialog.getByRole("button", { name: "Create connection" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    const row = page.getByRole("listitem").filter({ hasText: CONN_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Data source (custom)");
  });

  test("validation: missing fields and a bad endpoint URL show inline errors", async ({
    page,
  }) => {
    await page.goto("/settings/connections");
    await page.getByRole("button", { name: "Add connection" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Custom data source" }).click();

    // Missing required fields — name is checked first.
    await dialog.getByRole("button", { name: "Create connection" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Name the connection.");

    // Bad endpoint URL (unparseable).
    await dialog.getByLabel("Connection name").fill("Validation probe (never saved)");
    await dialog.getByLabel("Endpoint URL").fill("not-a-url");
    await dialog.getByRole("button", { name: "Create connection" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Enter a valid URL");

    // A private/loopback endpoint trips the same save-time SSRF gate (#220) with its own
    // dedicated message, distinct from a merely-unparseable URL. Must be https: outside
    // NODE_ENV=development the gate demands HTTPS before it ever looks at the host, and the
    // suite runs against the production bundle in CI.
    await dialog.getByLabel("Endpoint URL").fill("https://127.0.0.1/logs");
    await dialog.getByRole("button", { name: "Create connection" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(ENDPOINT_INTERNAL_MESSAGE);

    // Never submitted — close without creating anything.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("dataset Test query preview refuses a private/loopback endpoint", async ({
    page,
  }) => {
    // The "Test query" preview control (#39) only lives in the schedule wizard's inline
    // create-Connection flow (see AGENTS.md's Dataset Connections note) — the standalone Add
    // Connection dialog on /settings/connections has no such control. Drive the wizard's System
    // step to reach it, but stop short of submitting so no schedule/connection is created.
    await page.goto("/schedules");
    await page.getByRole("button", { name: "New" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "New schedule" }),
    ).toBeVisible();

    await dialog.getByLabel("Name", { exact: true }).fill(`E2E ssrf probe ${RUN_ID}`);
    await dialog.getByRole("button", { name: "Next" }).click();

    // System step — create a new Connection (Team A's default mode is "Use existing" against
    // the seeded agent connection) rather than reusing it, and pick the custom-dataset type.
    await dialog.getByRole("button", { name: "New connection" }).click();
    await dialog.getByRole("button", { name: "Custom data source" }).click();

    const testQueryButton = dialog.getByRole("button", { name: "Test query" });
    await expect(testQueryButton).toBeVisible();

    await dialog.getByLabel("Connection name").fill(`E2E ssrf probe conn ${RUN_ID}`);
    // A classic SSRF target (cloud metadata link-local address). The save-time gate (the same
    // one item 2 exercises) refuses it before any request is ever attempted — deterministic,
    // no network involved, so this can never hang waiting on a real fetch. https: for the same
    // production-bundle reason as above.
    await dialog
      .getByLabel("Endpoint URL")
      .fill("https://169.254.169.254/latest/meta-data");
    await expect(testQueryButton).toBeDisabled();

    // Advancing surfaces the same refusal as the step's error banner.
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(ENDPOINT_INTERNAL_MESSAGE);

    // Close without creating anything.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("delete removes the scratch connection from the list", async ({ page }) => {
    await page.goto("/settings/connections");
    const row = page.getByRole("listitem").filter({ hasText: CONN_NAME });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: `Delete ${CONN_NAME}` }).click();

    await expect(
      page.getByRole("heading", { name: "Delete connection" }),
    ).toBeVisible();
    // Two-press destructive confirm (#225): "Delete" then "Delete forever?".
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete forever?" }).click();

    await expect(
      page.getByRole("heading", { name: "Delete connection" }),
    ).toBeHidden();
    await expect(row).toHaveCount(0);
  });
});
