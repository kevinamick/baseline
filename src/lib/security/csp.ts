/**
 * Builds the Content-Security-Policy for a single request. A fresh nonce is minted
 * per request in `proxy.ts`; Next applies it to the inline scripts it injects, and
 * `'strict-dynamic'` extends that trust to the chunks they load — so no host
 * allowlist for our own bundles is needed.
 *
 * External origins are deliberately few: PostHog is proxied through `/ingest/*`
 * and Sentry through `/monitoring` (see next.config.ts), so both are same-origin
 * and covered by `'self'`. Only Supabase (the browser auth/REST/realtime client)
 * is genuinely cross-origin, so its origin is added to `connect-src`. Stripe is
 * server-side only here (no Stripe.js), so it needs no directives yet.
 */
export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";

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

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      // next dev (HMR / React Refresh) evaluates code at runtime; prod build does not.
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    // Tailwind ships as a build-time stylesheet, but React still emits inline
    // style attributes (dynamic widths, etc.), which need 'unsafe-inline'.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...connectExtra],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'"],
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
