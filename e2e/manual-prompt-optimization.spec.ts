import { test, expect } from "./fixtures";
import { ANON_STATE } from "./constants";

// The manual-prompt-optimization DIY guide (#432): a public, signed-out marketing
// page reusing the shared category-lander machinery already covered generically by
// docs-seo.spec.ts (English render, JSON-LD, docs-hub link). This spec adds the
// page-specific checks the issue calls for: all three locales render the guide,
// its distinguishing sections (the copy-paste prompt, the closer) are present, and
// the closing link actually lands on /prompt-optimization.

test.use({ storageState: ANON_STATE });

test.describe("manual prompt optimization guide", () => {
  test("renders the English guide with the walkthrough, copy-paste prompt, and FAQ", async ({
    page,
  }) => {
    const response = await page.goto("/manual-prompt-optimization");
    expect(response?.status()).toBe(200);

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Optimize a prompt by hand, one honest round at a time",
      })
    ).toBeVisible();

    // The walkthrough step that hands the loop to an assistant, plus its
    // copy-paste prompt block rendered as preformatted text.
    await expect(
      page.getByRole("heading", { name: "Hand the loop to an AI assistant" })
    ).toBeVisible();
    await expect(
      page.getByText(/helping me manually improve an AI prompt/i)
    ).toBeVisible();

    // The honest self-scoring caveat (step 4).
    await expect(page.getByText(/drift generous over time/i)).toBeVisible();

    // FAQs.
    await expect(
      page.getByRole("heading", { name: "Frequently asked questions" })
    ).toBeVisible();
    await expect(
      page.getByText("Can ChatGPT or Claude actually improve a prompt?")
    ).toBeVisible();
  });

  test("mirrors the manual loop in the closer and links to /prompt-optimization", async ({
    page,
  }) => {
    await page.goto("/manual-prompt-optimization");

    await expect(
      page.getByRole("heading", { name: "How Baseline does it" })
    ).toBeVisible();
    await expect(page.getByText("Frozen Instances")).toBeVisible();
    await expect(page.getByText("Rubric-based judging")).toBeVisible();

    const closingLink = page.getByRole("link", {
      name: "See how Baseline automates this loop",
    });
    await expect(closingLink).toBeVisible();
    await expect(closingLink).toHaveAttribute("href", "/prompt-optimization");

    await closingLink.click();
    await expect(page).toHaveURL(/\/prompt-optimization$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("renders the Spanish guide under /es/manual-prompt-optimization", async ({
    page,
  }) => {
    await page.goto("/es/manual-prompt-optimization");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Optimiza un prompt a mano, una ronda honesta a la vez",
      })
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "Descubre cómo Baseline automatiza este proceso",
      })
    ).toHaveAttribute("href", "/es/prompt-optimization");
  });

  test("renders the French guide under /fr/manual-prompt-optimization", async ({
    page,
  }) => {
    await page.goto("/fr/manual-prompt-optimization");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Optimiser un prompt à la main, un tour honnête à la fois",
      })
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "Découvrez comment Baseline automatise ce processus",
      })
    ).toHaveAttribute("href", "/fr/prompt-optimization");
  });
});
