import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { clientIpFromHeaders } from "@/lib/rate-limit/client-ip";

/**
 * OAuth callback. After a social sign-in (see signInWithOAuth in
 * src/app/actions/auth.ts) the provider redirects back here with a `code`; we
 * exchange it for a session — which sets the cookie via the SSR client — then
 * land the user on `next` (default /dashboard). Listed as a public route in
 * proxy.ts. The token_hash email flows go through /auth/confirm instead.
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
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  return NextResponse.redirect(new URL("/sign-in?error=oauth", request.url));
}
