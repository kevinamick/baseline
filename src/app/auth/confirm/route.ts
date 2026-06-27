import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createRouteClient } from "@/lib/supabase/route-client";
import { resolveOnboardingRedirect } from "@/lib/auth/post-auth-redirect";
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
 * the dashboard (or onboarding if they have no team yet). Listed as a public
 * route in proxy.ts.
 *
 * Cookie bridge: the Supabase client is created with a `NextResponse` so the
 * session cookies set by `verifyOtp` ride on the redirect response itself —
 * not the internal response that `next/headers` discards. This eliminates the
 * first-click race where the browser followed the redirect before the session
 * cookie landed (#354).
 *
 * Post-auth onboarding: if the verified user has no org membership, redirect to
 * `/onboarding` instead of `/dashboard` so the onboarding wizard shows
 * immediately (#355), not deferred to a manual `/dashboard` navigation.
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
    // Create the response that will carry the redirect, then create the Supabase
    // client bridged to it so the session cookies land on the browser (#354).
    const response = NextResponse.redirect(new URL(next, request.url));
    const supabase = createRouteClient(request, response);
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      // Recovery flows keep their `next` (/reset-password); all other flows
      // check for an org membership — no org means onboarding (#355).
      if (type === "recovery") {
        return response;
      }
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

  return NextResponse.redirect(new URL("/sign-in?error=confirm", request.url));
}
