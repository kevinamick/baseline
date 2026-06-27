import { NextResponse, type NextRequest } from "next/server";
import { createRouteClient } from "@/lib/supabase/route-client";
import { resolveOnboardingRedirect } from "@/lib/auth/post-auth-redirect";
import { safeNext } from "@/lib/auth/safe-next";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { clientIpFromHeaders } from "@/lib/rate-limit/client-ip";

/**
 * OAuth callback. After a social sign-in (see signInWithOAuth in
 * src/app/actions/auth.ts) the provider redirects back here with a `code`; we
 * exchange it for a session — which sets the cookie via the SSR client — then
 * land the user on `next` (default /dashboard, or /onboarding if they have no
 * team). Listed as a public route in proxy.ts.
 *
 * Cookie bridge: the Supabase client is created with a `NextResponse` so the
 * session cookies set by `exchangeCodeForSession` ride on the redirect response
 * itself — not the internal response that `next/headers` discards. This
 * eliminates the first-click race where the browser followed the redirect
 * before the session cookie landed (#354).
 *
 * Post-auth onboarding: if the authenticated user has no org membership,
 * redirect to `/onboarding` instead of `/dashboard` so the onboarding wizard
 * shows immediately (#355).
 */
export async function GET(request: NextRequest) {
  // Per-IP rate limit (ADR-0010): defense-in-depth on the OAuth code exchange.
  // Generic 429 over the limit; keyed off the request's trusted Vercel header.
  if (await checkLimit("authCallback", "ip", clientIpFromHeaders(request.headers))) {
    return new NextResponse(rateLimitMessage(), { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"), request.url);

  if (code) {
    // Create the response that will carry the redirect, then create the Supabase
    // client bridged to it so the session cookies land on the browser (#354).
    const response = NextResponse.redirect(new URL(next, request.url));
    const supabase = createRouteClient(request, response);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const redirectTarget = await resolveOnboardingRedirect(user, next);
      if (redirectTarget !== next) {
        return NextResponse.redirect(new URL(redirectTarget, request.url));
      }
      return response;
    }
  }

  return NextResponse.redirect(new URL("/sign-in?error=oauth", request.url));
}
