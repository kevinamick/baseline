import { test as base, expect } from "@playwright/test";

const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * The cookie that records a "rejected" consent choice, suppressing the
 * persistent cookie-consent banner (#68). The banner otherwise sits in the
 * lower-left of every page and intercepts clicks on left-column controls (the
 * rubric list, onboarding cards). "rejected" also keeps analytics off in tests.
 *
 * This is the single definition of that cookie: the global fixture below applies
 * it to every browser context the suite creates, and `global-setup` bakes it
 * into each pre-authenticated role's saved `storageState`.
 */
export function consentCookie(baseURL: string | undefined) {
  return {
    name: "analytics_consent",
    value: "rejected",
    domain: new URL(baseURL ?? DEFAULT_BASE_URL).hostname,
    path: "/",
  };
}

type ConsentFixtures = {
  /**
   * Whether to suppress the cookie-consent banner for this test. Defaults to
   * true for every spec that imports `test` from here. Set it to false via
   * `test.use({ suppressConsentBanner: false })` only for a test that must
   * actually SEE the banner (e.g. the first-time-visitor banner spec).
   */
  suppressConsentBanner: boolean;
  _consentBanner: void;
};

/**
 * The suite-wide base `test`. Every spec imports `test`/`expect` from here
 * instead of `@playwright/test` so the consent cookie is guaranteed present on
 * EVERY context — including fresh contexts a spec creates itself with
 * `browser.newContext()` (new signups, isolated Free-team flows), which do not
 * inherit a pre-authenticated role's saved `storageState`. This replaces the
 * per-spec `recordConsentChoice` patches that had to be re-added by hand each
 * time a UI change shifted layout near the lower-left banner.
 */
export const test = base.extend<ConsentFixtures>({
  suppressConsentBanner: [true, { option: true }],
  _consentBanner: [
    async ({ browser, baseURL, suppressConsentBanner }, runTest) => {
      if (!suppressConsentBanner) {
        await runTest();
        return;
      }
      const cookie = consentCookie(baseURL);
      // Patch newContext for the duration of the test so the default `page`
      // context AND any context the spec opens itself both get the cookie. The
      // browser is worker-scoped and tests run serially within a worker, so
      // patching per test and restoring after is race-free.
      const originalNewContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await originalNewContext(options);
        await context.addCookies([cookie]);
        return context;
      };
      try {
        await runTest();
      } finally {
        browser.newContext = originalNewContext;
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { Browser, BrowserContext, Page } from "@playwright/test";

/**
 * Assert UI state that a just-completed server action should have produced,
 * tolerating a lost client refresh.
 *
 * After a mutating server action resolves, the page updates through two racy
 * channels: the action response's own rerendered RSC payload and the client's
 * follow-up `router.refresh()`. Under CI load the two commits can interleave
 * so that both are dropped — the write landed (the action resolved without
 * error) but the tree on screen stays stale, and nothing ever refetches. CI
 * traces show the refresh GET returning 200 and the DOM never updating.
 *
 * One hard reload recovers that state deterministically: it re-renders from
 * the database, so if the assertion still fails after a reload, the write
 * itself is wrong and the failure is real. Callers pass an assertion that
 * accepts an expect-style `{ timeout }` so the pre-reload attempt stays short.
 */
export async function expectAfterMutation(
  page: import("@playwright/test").Page,
  assert: (opts: { timeout: number }) => Promise<void>,
) {
  try {
    await assert({ timeout: 5_000 });
  } catch {
    await page.reload();
    await assert({ timeout: 10_000 });
  }
}
