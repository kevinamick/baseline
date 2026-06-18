import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A, READONLY_A, TEAM_A_NAME } from "./constants";

test.describe("team settings (Contributor)", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("lists the team members and danger zone", async ({ page }) => {
    await page.goto("/settings/team");
    await expect(
      page.getByRole("heading", { name: TEAM_A_NAME }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    // Both Team A members are listed.
    await expect(page.getByText(CONTRIBUTOR_A.email).first()).toBeVisible();
    await expect(page.getByText(READONLY_A.email).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Danger zone" }),
    ).toBeVisible();
  });
});

test.describe("account settings", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("renders profile, email and password sections", async ({ page }) => {
    await page.goto("/settings/account");
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Email" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();
  });
});
