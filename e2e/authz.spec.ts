import { test, expect } from "./fixtures";
import {
  CONTRIBUTOR_A,
  CONTRIBUTOR_B,
  READONLY_A,
  RUBRIC_SUPPORT,
  TEAM_B_RUBRIC_NAME,
  readSeed,
} from "./constants";

test.describe("Readonly Member restrictions", () => {
  test.use({ storageState: READONLY_A.storageState });

  test("sees rubrics but no create control", async ({ page }) => {
    await page.goto("/rubrics");
    await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New" })).toHaveCount(0);
  });

  test("cannot reach edit/delete or run controls", async ({ page }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
    await expect(page.getByRole("button", { name: "Run eval" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit rubric" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Delete rubric" }),
    ).toHaveCount(0);
  });

  test("account menu omits the Team settings link", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("link", { name: "Manage account" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Team settings" }),
    ).toHaveCount(0);
  });
});

test.describe("tenant isolation", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  test("a Team A user cannot open a Team B rubric", async ({ page }) => {
    const { teamBRubricId } = readSeed();
    await page.goto(`/rubrics/${teamBRubricId}`);
    // The detail route scopes by org_id and calls notFound() on a miss.
    await expect(page.getByText(TEAM_B_RUBRIC_NAME)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: TEAM_B_RUBRIC_NAME }),
    ).toHaveCount(0);
  });

  // The list probe targets the missing-org-filter bug class directly: tenant
  // isolation is app-code-only (service-role client, no RLS policies), so one
  // forgotten `.eq("org_id", …)` on a list read leaks every tenant's rows.
  // Asserting the user's own rubric first guards against a vacuous pass on a
  // page that failed to load anything.
  test("the rubrics list never shows another Team's rubric", async ({
    page,
  }) => {
    await page.goto("/rubrics");
    await expect(page.getByText(RUBRIC_SUPPORT).first()).toBeVisible();
    await expect(page.getByText(TEAM_B_RUBRIC_NAME)).toHaveCount(0);
  });
});

test.describe("tenant isolation — Team B side", () => {
  test.use({ storageState: CONTRIBUTOR_B.storageState });

  // The mirror of the Team A list probe: Team B sees its own rubric and none of
  // Team A's. Symmetric probes catch a leak regardless of seed ordering (a
  // scoping bug that happens to return only the first-seeded org's rows would
  // pass a one-sided check).
  test("Team B's rubrics list never shows a Team A rubric", async ({
    page,
  }) => {
    await page.goto("/rubrics");
    await expect(page.getByText(TEAM_B_RUBRIC_NAME).first()).toBeVisible();
    await expect(page.getByText(RUBRIC_SUPPORT)).toHaveCount(0);
  });

  test("a Team B user cannot open a Team A rubric", async ({ page }) => {
    const { teamARubricId } = readSeed();
    await page.goto(`/rubrics/${teamARubricId}`);
    await expect(page.getByText(RUBRIC_SUPPORT)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: RUBRIC_SUPPORT }),
    ).toHaveCount(0);
  });
});
