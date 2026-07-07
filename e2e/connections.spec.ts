import { test, expect, type Page } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import {
  ANON_STATE,
  CONTRIBUTOR_A,
  READONLY_A,
  TEAM_B_NAME,
} from "./constants";

// The /settings/connections surface (#119): the team's Connections with a Modules edit
// dialog on agent rows. The seed creates exactly one agent connection on Team A with two
// Modules; Team B has none.
const SEED_CONNECTION = "Acme support agent (seed)";

// Mirrors the helper in a11y.spec.ts: only serious/critical violations gate.
async function expectNoSeriousA11yViolations(page: Page, context?: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking,
    `serious/critical a11y violations${context ? ` (${context})` : ""}:\n${blocking
      .map((v) => `  - ${v.id} (${v.impact}): ${v.help}`)
      .join("\n")}`,
  ).toEqual([]);
}

// Wait out the dialog's fade-in before an axe scan: axe computes contrast against the
// composited colors, so scanning mid-animation measures partial opacity (matches the
// approach the rubric-dialog a11y test uses).
async function settleAnimations(page: Page, selector: string) {
  await page
    .locator(selector)
    .evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
}

test.describe("functionality (Contributor)", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("lists the team's agent connection with its Modules", async ({
    page,
  }) => {
    await page.goto("/settings/connections");
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: SEED_CONNECTION });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Live agent");
    // Seeded Modules (system, style) are rendered on the agent row.
    await expect(row).toContainText("system");
    await expect(row).toContainText("style");
  });

  test("the account menu links to the Connections page", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("link", { name: "Connections" }).click();
    await expect(page).toHaveURL(/\/settings\/connections$/);
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
  });

  test("Edit Modules opens a dialog seeded with the connection's Modules", async ({
    page,
  }) => {
    await page.goto("/settings/connections");
    await page
      .getByRole("listitem")
      .filter({ hasText: SEED_CONNECTION })
      .getByRole("button", { name: "Edit Modules" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: `Edit Modules — ${SEED_CONNECTION}` }),
    ).toBeVisible();
    // Existing Modules are loaded into the editor's name fields (aria-label is "Module N name").
    await expect(dialog.getByLabel("Module 1 name")).toHaveValue("system");
    // Cancel closes without persisting.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("save is blocked when a Module isn't referenced in the template", async ({
    page,
  }) => {
    await page.goto("/settings/connections");
    await page
      .getByRole("listitem")
      .filter({ hasText: SEED_CONNECTION })
      .getByRole("button", { name: "Edit Modules" })
      .click();
    const dialog = page.getByRole("dialog");

    // Drop the {{prompt:style}} reference from the template while "style" stays declared —
    // the declared↔referenced cross-check must reject the save.
    await dialog
      .getByLabel("Request body template (JSON)")
      .fill('{"input":"{{user_input}}","system":"{{prompt:system}}"}');
    await dialog.getByRole("button", { name: "Save Modules" }).click();

    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("style");
    // Still open — the bad save did not go through.
    await expect(dialog.getByRole("heading", { name: /Edit Modules/ })).toBeVisible();
  });

  test("a valid save round-trips and closes the dialog", async ({ page }) => {
    await page.goto("/settings/connections");
    await page
      .getByRole("listitem")
      .filter({ hasText: SEED_CONNECTION })
      .getByRole("button", { name: "Edit Modules" })
      .click();
    const dialog = page.getByRole("dialog");

    // No-op save (Modules unchanged) exercises the full updateConnectionModules round-trip
    // without mutating the seed's observable state.
    await dialog.getByRole("button", { name: "Save Modules" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // The row still shows the connection and its Modules after the refresh.
    const row = page.getByRole("listitem").filter({ hasText: SEED_CONNECTION });
    await expect(row).toContainText("system");
    await expect(row).toContainText("style");
  });
});

test.describe("security", () => {
  test.describe("anonymous", () => {
    test.use({ storageState: ANON_STATE });
    test("redirects /settings/connections to sign-in", async ({ page }) => {
      await page.goto("/settings/connections");
      await expect(page).toHaveURL(/\/sign-in/);
      await expect(
        page.getByRole("button", { name: "Sign in" }),
      ).toBeVisible();
    });
  });

  test.describe("Readonly Member", () => {
    test.use({ storageState: READONLY_A.storageState });

    test("sees connections but cannot edit Modules", async ({ page }) => {
      await page.goto("/settings/connections");
      const row = page.getByRole("listitem").filter({ hasText: SEED_CONNECTION });
      await expect(row).toBeVisible();
      // canWrite is false → the Edit Modules control is not rendered.
      await expect(
        page.getByRole("button", { name: "Edit Modules" }),
      ).toHaveCount(0);
    });

    test("does not see another team's connections", async ({ page }) => {
      await page.goto("/settings/connections");
      // The list is org-scoped; Team B's name must never appear.
      await expect(page.getByText(TEAM_B_NAME)).toHaveCount(0);
    });
  });
});

test.describe("accessibility", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("the page has no serious/critical violations", async ({ page }) => {
    await page.goto("/settings/connections");
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, "page");
  });

  test("the Edit Modules dialog has no serious/critical violations", async ({
    page,
  }) => {
    await page.goto("/settings/connections");
    await page
      .getByRole("listitem")
      .filter({ hasText: SEED_CONNECTION })
      .getByRole("button", { name: "Edit Modules" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await settleAnimations(page, '[role="dialog"]');
    await expectNoSeriousA11yViolations(page, "edit-modules dialog");
  });
});
