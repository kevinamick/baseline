import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ANON_STATE, CONTRIBUTOR_A, RUBRIC_SUPPORT, readSeed } from "./constants";

// Fail only on the impactful violations for v1 — minor/moderate are tracked
// separately. Anything serious/critical that turns up is a real finding: it gets
// fixed in its own PR, then this assertion guards against regressions.
const BLOCKING_IMPACTS = ["serious", "critical"];

async function expectNoSeriousA11yViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact && BLOCKING_IMPACTS.includes(v.impact),
  );
  expect(
    blocking,
    `serious/critical a11y violations:\n${blocking
      .map((v) => `  - ${v.id} (${v.impact}): ${v.help}`)
      .join("\n")}`,
  ).toEqual([]);
}

test.describe("public pages", () => {
  test.use({ storageState: ANON_STATE });

  for (const path of ["/", "/sign-in"]) {
    test(`${path} has no serious/critical a11y violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoSeriousA11yViolations(page);
    });
  }
});

test.describe("authenticated pages", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  for (const path of ["/dashboard", "/rubrics"]) {
    test(`${path} has no serious/critical a11y violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoSeriousA11yViolations(page);
    });
  }

  test("rubric detail has no serious/critical a11y violations", async ({
    page,
  }) => {
    const { teamARubricId } = readSeed();
    await page.goto(`/rubrics/${teamARubricId}`);
    await expectNoSeriousA11yViolations(page);
  });

  // Finding A2 (agent-browser deep sweep): the account forms render labels as a
  // bare <span>, leaving the password/confirm/code inputs with no accessible
  // name. This surface was outside the original page-scan set.
  for (const path of ["/settings/account", "/settings/team"]) {
    test(`${path} has no serious/critical a11y violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoSeriousA11yViolations(page);
    });
  }

  // Finding A3 (agent-browser deep sweep): the create-rubric dialog's criterion
  // Name/Weight <label>s aren't associated with their inputs — the Weight number
  // input has no accessible name. A closed dialog escapes the static page scan,
  // so open it first, then scan.
  test("create-rubric dialog has no serious/critical a11y violations", async ({
    page,
  }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "New" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Wait out the form-reveal fade-in: axe computes contrast against the
    // *rendered* (composited) colors, so scanning mid-animation measures text at
    // partial opacity and dips below AA on otherwise-passing colors.
    await dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await expectNoSeriousA11yViolations(page);
  });

  test("run-eval dialog has no serious/critical a11y violations", async ({
    page,
  }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
    await page.getByRole("button", { name: "Run eval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await expectNoSeriousA11yViolations(page);
  });

  test("schedule-wizard dialog has no serious/critical a11y violations", async ({
    page,
  }) => {
    await page.goto("/schedules");
    await page.getByRole("button", { name: "New" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await expectNoSeriousA11yViolations(page);
  });

  test("optimization-wizard dialog has no serious/critical a11y violations", async ({
    page,
  }) => {
    await page.goto("/optimizations");
    await page.getByRole("button", { name: "+ New run" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await expectNoSeriousA11yViolations(page);
  });

  test("focused input in rubric dialog has a visible focus ring", async ({
    page,
  }) => {
    await page.goto("/rubrics");
    await page.getByRole("button", { name: "New" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Focus the Name input and verify a box-shadow (Tailwind ring) is applied.
    const nameInput = dialog.getByLabel("Name");
    await nameInput.focus();
    const boxShadow = await nameInput.evaluate(
      (el) => window.getComputedStyle(el).boxShadow,
    );
    // A non-empty, non-"none" box-shadow confirms the branded focus ring renders.
    expect(boxShadow).not.toBe("none");
    expect(boxShadow).not.toBe("");
  });
});
