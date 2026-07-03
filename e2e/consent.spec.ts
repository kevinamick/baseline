import { test, expect } from "./fixtures";
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
 */

const INGEST_PATH = "/ingest/";

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
    const preAcceptIngestRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes(INGEST_PATH)) preAcceptIngestRequests.push(req.url());
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Nothing analytics-related has any business running before a choice is made.
    expect(preAcceptIngestRequests).toEqual([]);

    const banner = page.getByRole("region", { name: "Cookie consent" });
    await expect(banner).toBeVisible();

    // Accept flips analytics on, which reloads the page to bring PostHog
    // online (cookie-consent.tsx) — set up the wait before the click so the
    // request that fires post-reload is caught regardless of timing.
    const ingestRequest = page.waitForRequest((req) => req.url().includes(INGEST_PATH), {
      timeout: 15_000,
    });
    await banner.getByRole("button", { name: "Accept" }).click();
    await ingestRequest;

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "analytics_consent")?.value).toBe("accepted");

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
    const ingestRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes(INGEST_PATH)) ingestRequests.push(req.url());
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
