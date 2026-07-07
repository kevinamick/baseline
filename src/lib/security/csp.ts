/**
 * Builds the Content-Security-Policy for a single request. A fresh nonce is minted
 * per request in `proxy.ts`; Next applies it to the inline scripts it injects, and
 * `'strict-dynamic'` extends that trust to the chunks they load — so no host
 * allowlist for our own bundles is needed.
 *
 * External origins are deliberately few: PostHog (product analytics + error
 * autocapture) is proxied through `/ingest/*` (see next.config.ts), so it's
 * same-origin and covered by `'self'`. Supabase (the browser auth/REST/
 * realtime client) is genuinely cross-origin, so its origin is added to
 * `connect-src`. Stripe is server-side only here (no Stripe.js), so it needs
 * no directives yet.
 *
 * Google Analytics (#448, consent-gated — src/app/_components/google-
 * analytics.tsx) is genuinely cross-origin too, unlike PostHog: gtag.js loads
 * from googletagmanager.com and its beacons/pageviews post to google-
 * analytics.com (both wildcarded — Google serves regional subdomains, e.g.
 * region1.google-analytics.com). Mirroring the Supabase-origin pattern above,
 * these hosts are only admitted when `NEXT_PUBLIC_GA_MEASUREMENT_ID` is
 * configured, so an environment with the tag off (local/e2e/staging) doesn't
 * even allow-list a host it never talks to. This is defense-in-depth on top
 * of, not a substitute for, the consent gate itself: consent (not the CSP)
 * is what keeps the request from firing when the tag IS configured but the
 * visitor hasn't accepted.
 *
 * On Vercel *preview* deployments only, Vercel injects its Live feedback toolbar,
 * which frames and loads scripts from `vercel.live` (plus a Pusher websocket for
 * real-time comments). Those origins are whitelisted solely when `VERCEL_ENV` is
 * `preview`, so production stays locked down to the directives above.
 */
export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  const isVercelPreview = process.env.VERCEL_ENV === "preview";

  // Supabase browser client → fetch + realtime websocket against its origin.
  const connectExtra: string[] = [];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      const { origin } = new URL(supabaseUrl);
      connectExtra.push(origin, origin.replace(/^http/, "ws"));
    } catch {
      // Malformed env — fall through with no extra connect origins.
    }
  }

  // GA4 (#448): gtag.js's own host, and the wildcarded collect/beacon host
  // (covers regional subdomains like region1.google-analytics.com).
  const gaConfigured = !!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  const gaScriptHosts = gaConfigured ? ["https://*.googletagmanager.com"] : [];
  const gaConnectHosts = gaConfigured
    ? ["https://*.googletagmanager.com", "https://*.google-analytics.com"]
    : [];
  const gaImgHosts = gaConfigured ? ["https://*.google-analytics.com"] : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      // next dev (HMR / React Refresh) evaluates code at runtime; prod build does not.
      ...(isDev ? ["'unsafe-eval'"] : []),
      ...(isVercelPreview ? ["https://vercel.live"] : []),
      ...gaScriptHosts,
    ],
    // Tailwind ships as a build-time stylesheet, but React still emits inline
    // style attributes (dynamic widths, etc.), which need 'unsafe-inline'.
    "style-src": [
      "'self'",
      "'unsafe-inline'",
      ...(isVercelPreview ? ["https://vercel.live"] : []),
    ],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      ...(isVercelPreview ? ["https://vercel.live", "https://vercel.com"] : []),
      ...gaImgHosts,
    ],
    "font-src": [
      "'self'",
      "data:",
      ...(isVercelPreview ? ["https://assets.vercel.com"] : []),
    ],
    "connect-src": [
      "'self'",
      ...connectExtra,
      ...(isVercelPreview
        ? ["https://vercel.live", "wss://ws-us3.pusher.com", "https://*.pusher.com"]
        : []),
      ...gaConnectHosts,
    ],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'", ...(isVercelPreview ? ["https://vercel.live"] : [])],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };

  const policy = Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(" ")}`)
    .join("; ");

  // Force HTTPS in production; omit locally so http://localhost isn't upgraded.
  return isDev ? policy : `${policy}; upgrade-insecure-requests`;
}
