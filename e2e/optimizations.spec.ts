import { test, expect } from "@playwright/test";
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

test("a Free-plan Contributor sees the upgrade gate, not the New run button (#181)", async ({
  page,
}) => {
  await page.goto("/optimizations");
  // Team A is Free: Optimization Runs aren't included, so the entry point is a
  // gated upgrade link — the seeded run HISTORY above stays fully visible.
  await expect(page.getByTestId("optimization-gate")).toContainText("Upgrade to optimize");
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
