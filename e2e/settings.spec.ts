import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A, TEAM_A_NAME } from "./constants";

// The team settings page is the Workspace's provider keys (ADR-0020): there is
// no membership to manage, no invite form, and no danger zone.
test.describe("team settings (provider keys)", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("shows the Workspace name and its provider keys, nothing member-related", async ({ page }) => {
    await page.goto("/settings/team");
    await expect(
      page.getByRole("heading", { name: TEAM_A_NAME }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Provider keys" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Danger zone" })).toHaveCount(0);
  });
});
