import { test, expect, type Page } from "./fixtures";
import { ANON_STATE } from "./constants";

/**
 * Cookie-consent banner flows (#67, #68): the first-visit banner, the
 * accept/reject choices and their persistence, and the "Cookie preferences"
 * reopen control (`cookie-preferences-button.tsx`). Every test here opts OUT
 * of the suite-wide consent-cookie fixture (`suppressConsentBanner: false`)
 * since the whole point is to actually see and drive the banner — the same
 * opt-out `localization.spec.ts`'s first-time-visitor test uses.
 *
 * PostHog is proxied same-origin under `/ingest/*` (next.config.ts rewrites +
 * `instrumentation-client.ts`'s `api_host: "/ingest"`), so "no analytics
 * fired" is asserted by watching for zero page requests whose URL contains
 * `/ingest/`, and "analytics is now live" by waiting for one.
 *
 * Google Analytics (#448) is genuinely cross-origin (googletagmanager.com /
 * google-analytics.com) — unlike PostHog it is never proxied same-origin, so
 * every request to either host is routed through a `page.route()` intercept
 * that fulfills locally rather than letting it reach real Google (never hit
 * Google in CI/local runs); the intercept still fires the `request` event we
 * assert on either way.
 */

const INGEST_PATH = "/ingest/";
const GA_HOST_PATTERN = "**://*.{googletagmanager,google-analytics}.com/**";

// PostHog only initializes when a key is configured. CI's workflow env falls back
// to an empty NEXT_PUBLIC_POSTHOG_KEY (no repo var set), so the "analytics goes
// live" network-positive assertion can only run where a key exists — locally the
// playwright config loads it from .env.local. The negative assertions (nothing
// fires pre-consent, cookie + banner behavior) hold either way.
const POSTHOG_CONFIGURED = !!process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Same story for the GA4 tag: it only renders when NEXT_PUBLIC_GA_MEASUREMENT_ID
// is baked into the build. CI's workflow env doesn't set it (no repo var, unlike
// even NEXT_PUBLIC_POSTHOG_KEY's optional one), so the "GA fires after Accept"
// network-positive assertion only runs where a local build set it (see
// .env.local.example) — a genuine, documented e2e coverage gap for the positive
// path in CI (issue #448). The negative assertions (no GA request ever, with no
// consent decision, and never after Reject) hold unconditionally either way —
// they're what actually protects the GDPR posture.
const GA_CONFIGURED = !!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

// Fulfills every request to a GA host locally rather than letting it reach
// real Google — the `request` event still fires for a routed request, so
// this only affects the RESPONSE, never whether we observe the attempt.
function blockGaNetwork(page: Page) {
  return page.route(GA_HOST_PATTERN, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "" })
  );
}

test.use({ storageState: ANON_STATE, suppressConsentBanner: false });

test.describe("cookie-consent banner (first-time visitor)", () => {
  test("shows on first visit with Accept and Reject controls", async ({ page }) => {
    await page.goto("/");
    const banner = page.getByRole("region", { name: "Cookie consent" });
    await expect(banner).toBeVisible();
    await expect(banner.getByText("We use cookies", { exact: true })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Accept" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Reject" })).toBeVisible();
  });
});

test.describe("Accept path", () => {
  test("no analytics fires before Accept; Accept sets the cookie, hides the banner for good, and analytics goes live", async ({
    page,
  }) => {
    await blockGaNetwork(page);

    const preAcceptIngestRequests: string[] = [];
    // Tracked for the whole test (survives the post-accept reload below), not
    // just pre-accept — reused for the GA_CONFIGURED=false branch further down.
    const gaRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes(INGEST_PATH)) preAcceptIngestRequests.push(req.url());
      if (req.url().includes("googletagmanager.com") || req.url().includes("google-analytics.com")) {
        gaRequests.push(req.url());
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Nothing analytics-related has any business running before a choice is made.
    expect(preAcceptIngestRequests).toEqual([]);
    expect(gaRequests).toEqual([]);

    const banner = page.getByRole("region", { name: "Cookie consent" });
    await expect(banner).toBeVisible();

    // Accept flips analytics on, which reloads the page to bring PostHog (and,
    // when NEXT_PUBLIC_GA_MEASUREMENT_ID is baked into this build, GA) online
    // (cookie-consent.tsx) — set up the waits before the click so the request
    // that fires post-reload is caught regardless of timing.
    const ingestRequest = POSTHOG_CONFIGURED
      ? page.waitForRequest((req) => req.url().includes(INGEST_PATH), {
          timeout: 15_000,
        })
      : null;
    const gaRequest = GA_CONFIGURED
      ? page.waitForRequest(
          (req) =>
            req.url().includes("googletagmanager.com") ||
            req.url().includes("google-analytics.com"),
          { timeout: 15_000 }
        )
      : null;
    await banner.getByRole("button", { name: "Accept" }).click();
    if (ingestRequest) await ingestRequest;
    if (gaRequest) await gaRequest;

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "analytics_consent")?.value).toBe("accepted");

    // GA coverage gap when NEXT_PUBLIC_GA_MEASUREMENT_ID isn't baked into this
    // build (true in CI today, see GA_CONFIGURED above): confirm the tag stays
    // fully absent even after Accept — the unset-var off switch holds
    // regardless of consent.
    if (!GA_CONFIGURED) {
      await page.waitForLoadState("networkidle");
      expect(gaRequests).toEqual([]);
    }

    // The banner does not come back on its own after the reload, nor on a
    // subsequent one.
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("region", { name: "Cookie consent" })).toHaveCount(0);
  });
});

test.describe("Reject path", () => {
  test("Reject sets the cookie, keeps analytics off, and persists across reload", async ({
    page,
  }) => {
    await blockGaNetwork(page);

    const ingestRequests: string[] = [];
    const gaRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes(INGEST_PATH)) ingestRequests.push(req.url());
      if (req.url().includes("googletagmanager.com") || req.url().includes("google-analytics.com")) {
        gaRequests.push(req.url());
      }
    });

    await page.goto("/");
    const banner = page.getByRole("region", { name: "Cookie consent" });
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Reject" }).click();

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "analytics_consent")?.value).toBe("rejected");

    // Analytics was already off and stays off, so this is not a toggle — no
    // auto-reload happens. Reload manually and confirm the choice stuck and
    // the banner does not reappear.
    await page.reload();
    await expect(page.getByRole("region", { name: "Cookie consent" })).toHaveCount(0);
    const cookiesAfterReload = await page.context().cookies();
    expect(cookiesAfterReload.find((c) => c.name === "analytics_consent")?.value).toBe(
      "rejected"
    );

    await page.waitForLoadState("networkidle");
    expect(ingestRequests).toEqual([]);
    // Reject never fires GA either, unconditionally — this holds regardless of
    // GA_CONFIGURED (unset means it was already never going to render the tag;
    // configured means the consent gate itself is what's under test here).
    expect(gaRequests).toEqual([]);
  });
});

test.describe("Cookie preferences reopen control", () => {
  test("the privacy page's cookie-preferences link reopens the choice", async ({
    page,
  }) => {
    await page.goto("/privacy");
    const banner = page.getByRole("region", { name: "Cookie consent" });
    await expect(banner).toBeVisible();
    // Make an initial choice so the banner closes and a "manage" reopen (with
    // a status line + close control, rather than the first-run prompt) has
    // something to show.
    await banner.getByRole("button", { name: "Reject" }).click();
    await expect(banner).toHaveCount(0);

    // The inline privacy-notice copy renders its own reopen control, distinct
    // text from the footer's "Cookie preferences" link, so it's unambiguous.
    await page.getByRole("button", { name: "Manage cookie preferences" }).click();

    const reopened = page.getByRole("region", { name: "Cookie consent" });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText("Cookie preferences", { exact: true })).toBeVisible();
    await expect(reopened.getByText(/Analytics are currently/)).toContainText("off");
    await expect(
      reopened.getByRole("button", { name: "Close cookie preferences" })
    ).toBeVisible();

    // Closing it (without changing the choice) leaves the prior choice intact.
    await reopened.getByRole("button", { name: "Close cookie preferences" }).click();
    await expect(page.getByRole("region", { name: "Cookie consent" })).toHaveCount(0);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "analytics_consent")?.value).toBe("rejected");
  });

  test("the footer's cookie-preferences link reopens the choice", async ({ page }) => {
    await page.goto("/privacy");
    const banner = page.getByRole("region", { name: "Cookie consent" });
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Accept" }).click();

    // Accept toggles analytics on, which reloads the page (cookie-consent.tsx).
    await page.waitForLoadState("load");
    await expect(page.getByRole("region", { name: "Cookie consent" })).toHaveCount(0);

    await page.getByRole("contentinfo").getByRole("button", { name: "Cookie preferences" }).click();
    const reopened = page.getByRole("region", { name: "Cookie consent" });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText(/Analytics are currently/)).toContainText("on");
  });
});
