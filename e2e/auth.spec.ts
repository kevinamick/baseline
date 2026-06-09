import { test, expect } from "@playwright/test";
import { ANON_STATE, CONTRIBUTOR_A } from "./constants";

// Every test in this file runs signed-out.
test.use({ storageState: ANON_STATE });

// Protected routes (everything not in proxy.ts PUBLIC_ROUTES). /reset-password is
// deliberately protected — it's reached via a recovery session, not signed-out.
const PROTECTED = [
  "/dashboard",
  "/rubrics",
  "/schedules",
  "/optimizations",
  "/settings/team",
  "/settings/account",
  "/reset-password",
];

test.describe("auth gating (signed out)", () => {
  for (const path of PROTECTED) {
    test(`redirects ${path} to /sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in/);
    });
  }

  test("sign-in page renders", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(
      page.getByRole("heading", { name: "Sign in to Baseline" }),
    ).toBeVisible();
  });

  test("landing page is reachable signed-out", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
  });
});

test.describe("sign-in flow", () => {
  test("valid credentials land on the dashboard", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(CONTRIBUTOR_A.email);
    await page.getByLabel("Password").fill(CONTRIBUTOR_A.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("invalid credentials show an error and stay on /sign-in", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(CONTRIBUTOR_A.email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
