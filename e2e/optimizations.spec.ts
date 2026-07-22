import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A, CONTRIBUTOR_C } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

// The seed creates a completed optimization run on the "Acme support agent (seed)"
// connection, which the list renders by connection name.
const SEED_CONNECTION = "Acme support agent (seed)";

test("optimizations list shows the seeded run", async ({ page }) => {
  await page.goto("/optimizations");
  // sr-only <h1>Optimizations</h1> + panel <h2>Optimizations</h2> share the name.
  await expect(
    page.getByRole("heading", { name: "Optimizations" }).first(),
  ).toBeVisible();
  await expect(page.getByText(SEED_CONNECTION).first()).toBeVisible();
});

test("a Free-plan Contributor whose lifetime run is used sees the upgrade gate, not the New run button (#181)", async ({
  page,
}) => {
  await page.goto("/optimizations");
  // Team A is Free with its ONE lifetime Optimization Run consumed (the seed
  // writes the ledger rows for the completed run above), so the entry point is
  // a gated upgrade link — the seeded run HISTORY stays fully visible. The
  // fresh-Team ("1 available") and release states live in
  // free-lifetime-optimization.spec.ts against Team B.
  const gate = page.getByTestId("optimization-gate");
  await expect(gate).toContainText("Upgrade to optimize");
  await expect(gate).toHaveAttribute("title", /has been used/);
  await expect(page.getByRole("button", { name: "+ New run" })).toHaveCount(0);
});

test("a paid-plan Contributor sees the live New run control", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
  const page = await ctx.newPage();
  await page.goto("/optimizations");
  await expect(page.getByRole("button", { name: "+ New run" })).toBeVisible();
  await ctx.close();
});

test("selecting the seeded run shows its detail", async ({ page }) => {
  await page.goto("/optimizations");
  await page.getByText(SEED_CONNECTION).first().click();
  // Detail pane echoes the connection name as its heading.
  await expect(
    page.getByRole("heading", { name: SEED_CONNECTION }),
  ).toBeVisible();
});

test.describe("breadcrumb step navigation", () => {
  // The wizard's entry point ("+ New run") is paid-only (#181) — Team A is Free and
  // sees the upgrade gate instead. Drive these as CONTRIBUTOR_C, whose Builder team
  // also has a seeded rubric + optimizable connection, so Basics and System validate
  // and "Next" can advance through the steps the breadcrumbs track.
  test.use({ storageState: CONTRIBUTOR_C.storageState });

  test.beforeEach(async ({ page }) => {
    await page.goto("/optimizations");
    await page.getByRole("button", { name: "+ New run" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("initial wizard state has no breadcrumb buttons", async ({ page }) => {
    // On Basics (first step), no previous steps exist — no breadcrumb buttons.
    await expect(
      page.getByRole("button", { name: "Go to Basics step" }),
    ).not.toBeVisible();
  });

  test("Basics breadcrumb becomes interactive after advancing to System", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Next" }).click();
    // Now on System — Basics should be a clickable breadcrumb button.
    await expect(
      page.getByRole("button", { name: "Go to Basics step" }),
    ).toBeVisible();
  });

  test("clicking the Basics breadcrumb from System navigates back to Basics", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Next" }).click();
    // Verify we're on System via the current step pill. Exact match: the connection's
    // tuned modules render lowercase "system" chips on this step, which a substring
    // (case-insensitive) getByText would also match — tripping strict mode.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("System", { exact: true })).toBeVisible();

    // Navigate back via breadcrumb.
    await page.getByRole("button", { name: "Go to Basics step" }).click();
    // Should be back on Basics (rubric select is present).
    await expect(dialog.getByRole("combobox")).toBeVisible();
    // Basics breadcrumb button should no longer exist (it's now current).
    await expect(
      page.getByRole("button", { name: "Go to Basics step" }),
    ).not.toBeVisible();
  });

  test("previously reached steps remain as breadcrumb buttons after going back", async ({
    page,
  }) => {
    // Advance past Basics and System.
    await page.getByRole("button", { name: "Next" }).click(); // → System
    // System defaults to the managed "Paste a prompt" mode (#293); pick the seeded existing
    // Connection so the step validates and Next advances to Instances.
    await page.getByRole("radio", { name: /Use an existing System/ }).check();
    await page.getByRole("button", { name: "Next" }).click(); // → Instances

    // Go back to Basics via the Back button.
    await page.getByRole("button", { name: "Back" }).click(); // → System
    await page.getByRole("button", { name: "Back" }).click(); // → Basics

    // Both System (index=1) and Instances (index=2) were reached — both should be clickable.
    await expect(
      page.getByRole("button", { name: "Go to System step" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Go to Instances step" }),
    ).toBeVisible();
  });

  test("clicking a forward breadcrumb jumps to a previously reached step", async ({
    page,
  }) => {
    // Advance to Instances (step 2).
    await page.getByRole("button", { name: "Next" }).click(); // → System
    // System defaults to the managed "Paste a prompt" mode (#293); pick the seeded existing
    // Connection so the step validates and Next advances to Instances.
    await page.getByRole("radio", { name: /Use an existing System/ }).check();
    await page.getByRole("button", { name: "Next" }).click(); // → Instances

    // Go back to Basics.
    await page.getByRole("button", { name: "Go to Basics step" }).click();

    // Now jump forward to Instances via its breadcrumb button.
    await page.getByRole("button", { name: "Go to Instances step" }).click();
    // Instances step is visible (the manual instance input).
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByPlaceholder("User input…")).toBeVisible();
  });
});
