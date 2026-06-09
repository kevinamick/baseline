import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ANON_STATE, CONTRIBUTOR_A, readSeed } from "./constants";

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
});
