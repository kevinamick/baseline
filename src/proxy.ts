import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { updateSession } from "@/lib/supabase/middleware";
import { buildCsp } from "@/lib/security/csp";
import { routing, locales, defaultLocale, type AppLocale } from "@/i18n/routing";
import { localizedPath } from "@/i18n/metadata";
import { CATEGORY_SLUGS } from "@/lib/marketing/categories";

// Routes reachable without a session, matched against the *locale-stripped* path
// (so `/es/pricing` is tested as `/pricing`). Everything else requires an
// authenticated Supabase user. `/auth/confirm` is the email-confirmation/recovery
// callback and `/auth/callback` the OAuth code exchange — both run before a
// session exists. The Stripe webhook is server-to-server (it authenticates by
// signature, not a session). `/reset-password` is deliberately NOT here: the
// recovery link opens a session via /auth/confirm first, so it's reached as a
// protected route.
const PUBLIC_ROUTES = [
  /^\/$/,
  /^\/sign-in(?:\/.*)?$/,
  /^\/sign-up(?:\/.*)?$/,
  // The pricing page is public marketing — reachable signed-out so a prospect
  // can compare plans before creating an account (#179).
  /^\/pricing$/,
  // The privacy & cookie notice must be reachable by anyone, signed-out
  // included — it's linked from the cookie banner and auth pages (#68).
  /^\/privacy$/,
  // The marketing/SEO surface (comparison pages, etc. — ADR-0013) is public:
  // crawlers and prospects reach it signed-out. Locale prefixes are stripped
  // before this match, so `/compare/braintrust` covers `/es/compare/...` too.
  /^\/compare(?:\/.*)?$/,
  // Category landers (#278) are flat top-level marketing URLs, public like the rest
  // of the SEO surface. Built from the single slug source so the table can't drift.
  // The `(?:/.*)?` tail keeps the colocated `opengraph-image` route public too —
  // otherwise social/crawler fetches of og:image get bounced to sign-in.
  new RegExp(`^/(?:${CATEGORY_SLUGS.join("|")})(?:/.*)?$`),
  // The /docs resources index (#306) is public marketing/SEO surface (ADR-0013):
  // prospects and crawlers reach it signed-out, same as the comparison and
  // category landers. The `(?:/.*)?` tail keeps colocated routes public too.
  /^\/docs(?:\/.*)?$/,
  // The /blog narrative-content surface (#435) is public marketing/SEO surface
  // like /docs — the index and every post reach signed-out visitors and
  // crawlers. The `(?:/.*)?` tail keeps colocated opengraph-image routes public.
  /^\/blog(?:\/.*)?$/,
  /^\/forgot-password(?:\/.*)?$/,
  /^\/auth\/confirm(?:\/.*)?$/,
  /^\/auth\/callback(?:\/.*)?$/,
  // Invitation accept links must be reachable signed-out so a brand-new invitee
  // can land here and be sent to sign-up/sign-in (#50).
  /^\/invite(?:\/.*)?$/,
  /^\/api\/webhooks\/stripe(?:\/.*)?$/,
  // The cron/worker-triggered internal routes authenticate themselves with a
  // bearer secret (requireInternalSecret) — pg_cron and the Fly worker have no
  // Supabase session cookie, so a session gate here 307s their calls to
  // /sign-in and the handlers never run.
  /^\/api\/internal\/(?:retention|managed-threshold|claim-reserve)$/,
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((re) => re.test(pathname));
}

// Auth-only public routes: an authenticated user hitting one of these is
// redirected to /dashboard instead of seeing the sign-in/sign-up/forgot-password
// form (#356). Root (`/`), marketing pages, and token-handling routes
// (/auth/confirm, /auth/callback) are excluded — root renders differently for
// signed-in vs signed-out visitors, and the token routes must always process.
const AUTH_ONLY_ROUTES = [
  /^\/sign-in(?:\/.*)?$/,
  /^\/sign-up(?:\/.*)?$/,
  /^\/forgot-password(?:\/.*)?$/,
];

function isAuthOnlyRoute(pathname: string): boolean {
  return AUTH_ONLY_ROUTES.some((re) => re.test(pathname));
}

const localeSet = new Set<string>(locales);

// The locale carried by a path's first segment (only non-default locales are
// ever prefixed under `localePrefix: 'as-needed'`), defaulting otherwise.
function localeOf(pathname: string): AppLocale {
  const seg = pathname.split("/")[1];
  return localeSet.has(seg) ? (seg as AppLocale) : defaultLocale;
}

// The path with any leading locale segment removed, so it can be matched against
// the (locale-agnostic) PUBLIC_ROUTES table: `/es/pricing` → `/pricing`.
function stripLocale(pathname: string): string {
  const seg = pathname.split("/")[1];
  if (localeSet.has(seg) && seg !== defaultLocale) {
    const rest = pathname.slice(seg.length + 1);
    return rest === "" ? "/" : rest;
  }
  return pathname;
}

// Paths that live *outside* the `[locale]` segment and must never be locale-routed:
// API + tRPC handlers, the Supabase auth callbacks, and the PostHog ingest proxy.
function isLocalizable(pathname: string): boolean {
  return !/^\/(?:api|trpc|auth|ingest)(?:\/|$)/.test(pathname);
}

const intlMiddleware = createMiddleware(routing);

export async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  // Per-request CSP nonce. Setting the policy on the *request* headers lets Next
  // read the nonce and stamp it onto the inline scripts it injects; we mirror the
  // same policy onto every response below so the browser enforces it.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const { pathname } = request.nextUrl;
  const localizable = isLocalizable(pathname);

  // 1. Locale routing. next-intl decides the active locale and returns either a
  //    redirect (cold visitor → their detected locale, or normalizing the
  //    prefix) or a pass-through that rewrites to the internal `/[locale]/…`
  //    path and carries the NEXT_LOCALE cookie.
  let intlResponse: NextResponse | null = null;
  if (localizable) {
    intlResponse = intlMiddleware(request);
    // A detection/normalization redirect has no body to refresh a session for —
    // short-circuit; the browser re-requests the prefixed URL next.
    if (intlResponse.headers.get("location")) {
      intlResponse.headers.set("x-request-id", requestId);
      intlResponse.headers.set("content-security-policy", csp);
      return intlResponse;
    }
  }

  // 2. Refresh the session so the rotated cookies (and our augmented request
  //    headers, incl. the nonce) ride on the response.
  const { user, response: sessionResponse } = await updateSession(
    request,
    requestHeaders
  );

  // 3. Locale-aware auth gate. Match the locale-stripped path against the public
  //    table; an unauthenticated request to a protected route goes to *its
  //    locale's* sign-in (e.g. `/es/sign-in`).
  const lookupPath = localizable ? stripLocale(pathname) : pathname;

  // 3a. Authenticated-user guard (#356): a signed-in user hitting a public auth
  //     page (sign-in, sign-up, forgot-password) is redirected to /dashboard.
  //     The redirect carries the rotated session cookies so the session survives
  //     the navigation.
  if (user && isAuthOnlyRoute(lookupPath)) {
    const locale = localizable ? localeOf(pathname) : defaultLocale;
    const redirect = NextResponse.redirect(
      new URL(localizedPath(locale, "/dashboard"), request.url)
    );
    sessionResponse.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    intlResponse?.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    redirect.headers.set("x-request-id", requestId);
    redirect.headers.set("content-security-policy", csp);
    return redirect;
  }

  if (!user && !isPublicRoute(lookupPath)) {
    const locale = localizable ? localeOf(pathname) : defaultLocale;
    const redirect = NextResponse.redirect(
      new URL(localizedPath(locale, "/sign-in"), request.url)
    );
    // Carry over the cookies @supabase/ssr rotated/cleared, the NEXT_LOCALE
    // cookie next-intl set, and the request id, so we don't desync.
    sessionResponse.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    intlResponse?.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    redirect.headers.set("x-request-id", requestId);
    redirect.headers.set("content-security-policy", csp);
    return redirect;
  }

  // 4. Compose. Re-issue next-intl's internal rewrite to `/[locale]/…` while
  //    forwarding our augmented request headers, then merge both responses'
  //    cookies (NEXT_LOCALE from intl, rotated auth cookies from Supabase).
  const rewrite = intlResponse?.headers.get("x-middleware-rewrite");
  const finalResponse = rewrite
    ? NextResponse.rewrite(new URL(rewrite, request.url), {
        request: { headers: requestHeaders },
      })
    : sessionResponse;

  if (intlResponse) {
    intlResponse.cookies.getAll().forEach((c) => finalResponse.cookies.set(c));
    if (rewrite) {
      sessionResponse.cookies
        .getAll()
        .forEach((c) => finalResponse.cookies.set(c));
      // Preserve any alternate-language Link header next-intl emitted.
      const link = intlResponse.headers.get("link");
      if (link) finalResponse.headers.set("link", link);
    }
  }

  finalResponse.headers.set("x-request-id", requestId);
  finalResponse.headers.set("content-security-policy", csp);
  return finalResponse;
}

export const config = {
  matcher: [
    // `xml`/`txt` are excluded so the metadata routes `/sitemap.xml` and
    // `/robots.txt` bypass locale routing AND the auth gate — otherwise an
    // unauthenticated crawler would be redirected to /sign-in.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|xml|txt)).*)",
    "/(api|trpc)(.*)",
  ],
};
