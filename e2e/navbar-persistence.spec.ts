import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });
test.setTimeout(120_000);

// Regression guard for #336: the app NavBar must NOT rebuild when navigating
// between app routes. It lives in the persistent `(app)/layout.tsx`, so each
// nav-link click is a client-side RSC navigation that keeps the nav mounted.
// This asserts three independent signals per hop, the strongest being the
// network classification (a mount-counter alone gave false confidence in the
// first cut, so this checks the actual transport):
//   • 0 `document` requests  — a document request = FULL page load = nav rebuild
//   • `window.__mark` survives — wiped by a real reload, so proves a soft nav
//   • nav <header> expando survives — proves the same DOM node, not re-mounted
// Verified to also hold against a production build (`next build && next start`).
test("NavBar is not rebuilt across app navigation (client RSC, no full load)", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(
    page.locator("header nav").getByRole("link", { name: "Rubrics" }),
  ).toBeVisible();

  // Plant markers after the initial load.
  await page.evaluate(() => {
    (window as unknown as { __mark?: string }).__mark = "ALIVE";
    const h = [...document.querySelectorAll("header")].find((el) =>
      el.querySelector("nav"),
    ) as (HTMLElement & { __probe?: string }) | undefined;
    if (h) h.__probe = "NODE_A";
  });

  const hops = [
    { label: "Rubrics", path: "/rubrics" },
    { label: "Schedules", path: "/schedules" },
    { label: "Optimizations", path: "/optimizations" },
    { label: "Dashboard", path: "/dashboard" },
  ];

  for (const hop of hops) {
    const reqs: { type: string; url: string }[] = [];
    const onReq = (r: import("@playwright/test").Request) =>
      reqs.push({ type: r.resourceType(), url: r.url() });
    page.on("request", onReq);

    await page.locator("header nav").getByRole("link", { name: hop.label }).click();
    await expect(page).toHaveURL(new RegExp(`${hop.path}$`), { timeout: 30_000 });
    await page.waitForTimeout(500);
    page.off("request", onReq);

    const docReqs = reqs.filter((r) => r.type === "document");
    const rscReqs = reqs.filter(
      (r) => r.url.includes("_rsc=") || r.type === "fetch",
    );
    const state = await page.evaluate(() => {
      const w = window as unknown as { __mark?: string };
      const h = [...document.querySelectorAll("header")].find((el) =>
        el.querySelector("nav"),
      ) as (HTMLElement & { __probe?: string }) | undefined;
      return {
        mark: w.__mark ?? "<<WIPED=reload>>",
        probe: h ? (h.__probe ?? "<<new-node>>") : "<<no-header>>",
      };
    });
    console.log(
      `HOP ${hop.label}: documentReqs=${docReqs.length} rsc/fetchReqs=${rscReqs.length} mark=${state.mark} node=${state.probe}` +
        (docReqs.length ? ` || DOC URLS: ${docReqs.map((d) => d.url).join(" , ")}` : ""),
    );
    // The assertion that matters: a hop must NOT trigger a full document load.
    expect(docReqs.length, `${hop.label}: full-document navigations (should be 0 for client nav)`).toBe(0);
    expect(state.mark, `${hop.label}: window marker survived (no reload)`).toBe("ALIVE");
    expect(state.probe, `${hop.label}: nav <header> is the same node`).toBe("NODE_A");
  }
});
