import { test, expect } from "@playwright/test";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });
test.setTimeout(120_000); // a dev-server cold compile on first route hit can be slow

// Regression guard for #336: the app NavBar must stay mounted across navigation
// between app routes. It lives in the persistent `(app)/layout.tsx`, so React
// keeps the exact same <header> DOM node — it is not re-mounted (and not blocked
// on a per-page server auth round-trip) on every transition.
//
// Technique: stamp two markers that only survive a *preserved* tree —
//   • `window.__navMark`            — wiped by a full document reload, so its
//                                     survival proves the hop was a client-side
//                                     navigation (not a hard reload).
//   • an expando on the nav <header> — React does not manage it, so it survives
//                                     iff the node itself is reused (not re-mounted).
// If a future change moves the NavBar back into the pages, the page (and its
// header node) re-mounts on navigation, the expando is gone, and this fails.

const APP_ROUTES = ["/dashboard", "/rubrics", "/schedules", "/optimizations"];

// Read both markers from the live page. Runs in the browser via page.evaluate.
function readMarkers() {
  const w = window as unknown as { __navMark?: string };
  const navHeader = [...document.querySelectorAll("header")].find((el) =>
    el.querySelector("nav"),
  ) as (HTMLElement & { __navProbe?: string }) | undefined;
  return {
    navMark: w.__navMark ?? "<<RELOADED>>",
    headerProbe: navHeader
      ? (navHeader.__navProbe ?? "<<NO-PROBE: re-mounted>>")
      : "<<NO-NAV-HEADER>>",
  };
}

test("NavBar persists (same DOM node) across navigation between app routes", async ({ page }) => {
  // Warm every route so the measured client-nav loop isn't racing first-hit
  // compilation on the dev server (a no-op against the built CI server).
  for (const r of APP_ROUTES) {
    await page.goto(r);
  }

  await page.goto("/dashboard");
  await expect(
    page.locator("header nav").getByRole("link", { name: "Rubrics" }),
  ).toBeVisible();

  // Plant the markers after the last full load.
  await page.evaluate(() => {
    (window as unknown as { __navMark?: string }).__navMark = "MARK";
    const navHeader = [...document.querySelectorAll("header")].find((el) =>
      el.querySelector("nav"),
    ) as (HTMLElement & { __navProbe?: string }) | undefined;
    if (navHeader) navHeader.__navProbe = "SAME-NODE";
  });

  const hops = [
    { label: "Rubrics", path: "/rubrics" },
    { label: "Schedules", path: "/schedules" },
    { label: "Optimizations", path: "/optimizations" },
    { label: "Dashboard", path: "/dashboard" },
  ];

  for (const hop of hops) {
    await page.locator("header nav").getByRole("link", { name: hop.label }).click();
    // Poll the URL itself — some app pages hold a connection open, so the
    // "load"/"networkidle" lifecycle never settles on a client-side navigation.
    await expect(page).toHaveURL(new RegExp(`${hop.path}$`), { timeout: 30_000 });
    await page.waitForTimeout(250); // let React commit the new page segment

    const state = await page.evaluate(readMarkers);
    expect(state.navMark, `${hop.label}: should be a client navigation, not a full reload`).toBe("MARK");
    expect(state.headerProbe, `${hop.label}: NavBar <header> must be the same node (not re-mounted)`).toBe("SAME-NODE");
  }
});
