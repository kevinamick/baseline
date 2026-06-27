import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { safeNext } from "@/lib/auth/safe-next";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { clientIpFromHeaders } from "@/lib/rate-limit/client-ip";

// The OTP types this endpoint is allowed to verify. Sign-up confirmation
// (`email`), the email-change flow (`email_change`, #53) and password recovery
// (`recovery`, #54) are the supported flows. Anything else (e.g. `magiclink`)
// is rejected so an attacker can't drive an unintended verification via ?type=.
const ALLOWED_OTP_TYPES = new Set<EmailOtpType>([
  "email",
  "email_change",
  "recovery",
]);

/**
 * Email-confirmation callback. The confirmation email (see
 * supabase/templates/confirmation.html) links here with a `token_hash`; we
 * verify it server-side, which sets the session cookie, then land the user on
 * the dashboard. Listed as a public route in proxy.ts.
 */
export async function GET(request: NextRequest) {
  // Per-IP rate limit (ADR-0010): defense-in-depth on top of token entropy.
  // Generic 429 over the limit. The route handler holds the request, so we key
  // off its headers directly (the trusted Vercel header, never client XFF).
  if (await checkLimit("authConfirm", "ip", clientIpFromHeaders(request.headers))) {
    return new NextResponse(rateLimitMessage(), { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const typeParam = searchParams.get("type") as EmailOtpType | null;
  const type = typeParam && ALLOWED_OTP_TYPES.has(typeParam) ? typeParam : null;
  const next = safeNext(searchParams.get("next"), request.url);

  if (tokenHash && type) {
    // Build the redirect response first so the Supabase client can write
    // session cookies directly onto it via setAll(). Using the request/response
    // cookie bridge (same pattern as middleware.ts) ensures the auth cookies
    // travel in this response's Set-Cookie headers. The previous approach
    // (createClient from ./server.ts) deferred cookie writes through
    // next/headers, which are NOT automatically propagated to a
    // NextResponse.redirect() — causing the race where the middleware auth
    // gate saw no session on the immediately-following redirect request.
    const redirectUrl = new URL(next, request.url);
    let response = NextResponse.redirect(redirectUrl);

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });

    if (!error) {
      return response;
    }
  }

  return NextResponse.redirect(new URL("/sign-in?error=confirm", request.url));
}
