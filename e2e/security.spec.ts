import { test, expect } from "./fixtures";
import { CONTRIBUTOR_A } from "./constants";

test.use({ storageState: CONTRIBUTOR_A.storageState });

test("sets a nonce-based Content-Security-Policy", async ({ page }) => {
  const res = await page.goto("/dashboard");
  const csp = res?.headers()["content-security-policy"];
  expect(csp, "CSP header is present").toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
});

test("mints a fresh CSP nonce per response", async ({ page }) => {
  const nonceOf = (csp?: string) =>
    csp?.match(/'nonce-([^']+)'/)?.[1] ?? null;
  const first = nonceOf((await page.goto("/dashboard"))?.headers()["content-security-policy"]);
  const second = nonceOf((await page.goto("/rubrics"))?.headers()["content-security-policy"]);
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(first).not.toBe(second);
});

test("sets the static security headers", async ({ page }) => {
  const headers = (await page.goto("/dashboard"))!.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toBeTruthy();
});

test("the service-role key is not exposed to the client", async ({ page }) => {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  test.skip(!serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY not set");

  await page.goto("/dashboard");
  const html = await page.content();
  expect(html).not.toContain(serviceRoleKey!);
  // And it must not appear in any first-party script the page loaded. Only fetch
  // same-origin scripts — third-party ones (analytics, etc.) are off the app's
  // server and could hang/404, and can't carry a server-only secret anyway.
  const pageOrigin = new URL(page.url()).origin;
  const scriptSrcs = await page
    .locator("script[src]")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLScriptElement).src));
  const sameOrigin = scriptSrcs.filter((src) => {
    try {
      return new URL(src).origin === pageOrigin;
    } catch {
      return false;
    }
  });
  for (const src of sameOrigin) {
    const body = await page.request.get(src).then((r) => r.text());
    expect(body, `service-role key leaked in ${src}`).not.toContain(
      serviceRoleKey!,
    );
  }
});
