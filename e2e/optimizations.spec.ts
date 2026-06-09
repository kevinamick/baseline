import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

// The seed creates a completed optimization run on the "Acme support agent (seed)"
// connection, which the list renders by connection name.
const SEED_CONNECTION = "Acme support agent (seed)";

test("optimizations list shows the seeded run", async ({ page }) => {
  await page.goto("/optimizations");
  await expect(
    page.getByRole("heading", { name: "Optimizations" }),
  ).toBeVisible();
  await expect(page.getByText(SEED_CONNECTION).first()).toBeVisible();
});

test("a Contributor sees the New run control", async ({ page }) => {
  await page.goto("/optimizations");
  await expect(page.getByRole("button", { name: "+ New run" })).toBeVisible();
});

test("selecting the seeded run shows its detail", async ({ page }) => {
  await page.goto("/optimizations");
  await page.getByText(SEED_CONNECTION).first().click();
  // Detail pane echoes the connection name as its heading.
  await expect(
    page.getByRole("heading", { name: SEED_CONNECTION }),
  ).toBeVisible();
});
