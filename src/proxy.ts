import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { buildCsp } from "@/lib/security/csp";
import { routing } from "@/i18n/routing";

// There is no session gate (ADR-0020): every route is reachable, and identity
// is the Local Workspace resolved by `getAuthContext()`. The proxy's remaining
// jobs are per-request correlation + CSP, URL canonicalization, and locale
// routing.

// Paths that live *outside* the `[locale]` segment and must never be locale-routed:
// API + tRPC handlers and the PostHog ingest proxy.
function isLocalizable(pathname: string): boolean {
  return !/^\/(?:api|trpc|ingest)(?:\/|$)/.test(pathname);
}

const intlMiddleware = createMiddleware(routing);

// Every early-return response must carry the request id (log correlation) and
// the per-request CSP — one stamping seam so a future header can't miss a site.
function stampHeaders(
  response: NextResponse,
  requestId: string,
  csp: string
): NextResponse {
  response.headers.set("x-request-id", requestId);
  response.headers.set("content-security-policy", csp);
  return response;
}

export async function proxy(request: NextRequest) {
  // Always mint — never trust an inbound x-request-id. A client-supplied value
  // would otherwise ride straight through to request-context logging and
  // instrumentation.ts's onRequestError (#508); requestHeaders.set() below
  // overwrites any spoofed header on the forwarded request too.
  const requestId = crypto.randomUUID();

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

  // Canonicalize away trailing slashes on page URLs before any routing
  // decision: `/rubrics/` 308s to `/rubrics` (query preserved) instead of
  // leaking a duplicate URL. ONLY localizable paths: the PostHog `/ingest/*`
  // endpoints intrinsically end in a slash (`/ingest/e/`) — the very redirect
  // next.config.ts's `skipTrailingSlashRedirect` suppresses — and slashed
  // API URLs must reach their handlers unredirected.
  if (localizable && pathname.length > 1 && pathname.endsWith("/")) {
    // Build from a plain URL — mutating a cloned NextURL's pathname re-appends
    // the slash it normalized from the incoming request, which would loop.
    const url = new URL(request.url);
    url.pathname = pathname.replace(/\/+$/, "");
    return stampHeaders(NextResponse.redirect(url, 308), requestId, csp);
  }

  // Locale routing. next-intl decides the active locale and returns either a
  // redirect (cold visitor → their detected locale, or normalizing the prefix)
  // or a pass-through that rewrites to the internal `/[locale]/…` path and
  // carries the NEXT_LOCALE cookie.
  let intlResponse: NextResponse | null = null;
  if (localizable) {
    intlResponse = intlMiddleware(request);
    if (intlResponse.headers.get("location")) {
      return stampHeaders(intlResponse, requestId, csp);
    }
  }

  // Compose. Re-issue next-intl's internal rewrite to `/[locale]/…` while
  // forwarding our augmented request headers (the nonce + request id), then
  // carry the NEXT_LOCALE cookie across.
  const rewrite = intlResponse?.headers.get("x-middleware-rewrite");
  const finalResponse = rewrite
    ? NextResponse.rewrite(new URL(rewrite, request.url), {
        request: { headers: requestHeaders },
      })
    : NextResponse.next({ request: { headers: requestHeaders } });

  if (intlResponse) {
    intlResponse.cookies.getAll().forEach((c) => finalResponse.cookies.set(c));
    if (rewrite) {
      // Preserve any alternate-language Link header next-intl emitted.
      const link = intlResponse.headers.get("link");
      if (link) finalResponse.headers.set("link", link);
    }
  }

  return stampHeaders(finalResponse, requestId, csp);
}

export const config = {
  matcher: [
    // `xml`/`txt` are excluded so the metadata routes `/sitemap.xml` and
    // `/robots.txt` bypass locale routing.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|xml|txt)).*)",
    "/(api|trpc)(.*)",
  ],
};
