import { headers } from "next/headers";
import { analyticsAllowedOnServer } from "@/lib/consent/server";

/**
 * Consent-gated GA4 loader tag (#448, docs/runbooks/production-launch.md §7).
 * Mirrors the PostHog client init's posture (#68): analytics is OFF until the
 * visitor has explicitly accepted, so this renders nothing at all — no
 * markup, no request to googletagmanager.com/google-analytics.com, no `_ga`
 * cookie — unless BOTH:
 *   1. NEXT_PUBLIC_GA_MEASUREMENT_ID is configured, and
 *   2. the visitor has accepted analytics.
 *
 * Unlike the PostHog init (a browser-side instrumentation entrypoint that
 * reads document.cookie), this is a Server Component that reads the same
 * cookie via next/headers (src/lib/consent/server.ts) and decides BEFORE any
 * HTML is sent — so an unconsented response never contains the tag, rather
 * than relying on client JS to suppress it after the fact. The consent
 * banner already reloads the page on any accept/reject toggle (cookie-
 * consent.tsx), so this server-side check re-runs and picks up a fresh
 * choice with no extra client-side wiring needed.
 *
 * The app sets a strict nonce CSP (`script-src 'nonce-…' 'strict-dynamic'`),
 * so both script tags carry the per-request nonce — same pattern as
 * ThemeScript / JsonLd.
 */
export async function GoogleAnalytics() {
  // Build-time inlined like every NEXT_PUBLIC_* var (read inline, not hoisted
  // to a module-level const, purely so Next's static replacement still applies
  // wherever this expression appears). Unset in local/e2e/staging — that
  // absence is the ONLY off switch there (#448); no mock/override backdoor.
  const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (!GA_MEASUREMENT_ID) return null;

  const allowed = await analyticsAllowedOnServer();
  if (!allowed) return null;

  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <>
      <script
        nonce={nonce}
        async
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
      />
      <script
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html:
            `window.dataLayer = window.dataLayer || [];` +
            `function gtag(){dataLayer.push(arguments);}` +
            `gtag('js', new Date());` +
            // IP anonymization is GA4's default behavior (no config flag,
            // unlike Universal Analytics); Google Signals stays off — that's
            // a console setting on the property, not a code-side flag.
            `gtag('config', '${GA_MEASUREMENT_ID}');`,
        }}
      />
    </>
  );
}
