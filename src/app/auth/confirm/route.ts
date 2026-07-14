import { NextResponse, after, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createRouteClient } from "@/lib/supabase/route-client";
import { resolveOnboardingRedirect } from "@/lib/auth/post-auth-redirect";
import { safeNext } from "@/lib/auth/safe-next";
import { log } from "@/lib/logging/server";
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

// The OTP types whose verify failure is recoverable via the "resend
// confirmation email" control (#498) — today just sign-up confirmation
// (`email`). recovery/email_change failures keep the generic ?error=confirm
// banner: neither has a "resend from sign-in" affordance (a stale recovery
// link is re-requested from /forgot-password; email_change from account
// settings). Table-driven alongside ALLOWED_OTP_TYPES above rather than an
// inline `type === "email"` check, so a future resend-recoverable type is one
// Set entry, not a second differently-shaped conditional.
const RESEND_RECOVERABLE_OTP_TYPES = new Set<EmailOtpType>(["email"]);

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
 * immediately (#355), not deferred to a manual `/dashboard` navigation. The
 * onboarding redirect response carries the session cookies from the original
 * response so the session survives the second redirect (#354).
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
        // Copy the session cookies onto the onboarding redirect so the session
        // survives the second redirect (otherwise #354 re-occurs for
        // onboarding-bound users).
        const onboardingRedirect = NextResponse.redirect(
          new URL(redirectTarget, request.url)
        );
        response.cookies.getAll().forEach((c) => onboardingRedirect.cookies.set(c));
        return onboardingRedirect;
      }
      return response;
    }
    // Token present but verification failed (expired or already-consumed token,
    // or a token issued for a different OTP type). Public, attacker-reachable
    // route — never buy a failed confirm a synchronous PostHog round-trip, so
    // the log (and its warn-level flush) runs in after() once the redirect is
    // sent: off the request's critical path, but still awaited by the runtime
    // so a serverless freeze can't drop the record.
    after(() =>
      log.warn("Email confirmation failed", {
        event: "auth.confirm_failed",
        reason: "verify_error",
        otp_type: type,
        error,
      })
    );
    // The confirm route no longer knows the email at this point (the token is
    // dead), so a resend-recoverable failure sends the user to the sign-in
    // page's inline resend control (#498) to collect it instead.
    if (RESEND_RECOVERABLE_OTP_TYPES.has(type)) {
      return NextResponse.redirect(
        new URL("/sign-in?error=confirm_expired", request.url)
      );
    }
  } else {
    // No verifyOtp call: either no token_hash, or a `type` outside the
    // allow-list (rejected above to stop attacker-driven verifications). The raw
    // submitted `type` is untrusted/unbounded, so we record only the cause.
    after(() =>
      log.warn("Email confirmation failed", {
        event: "auth.confirm_failed",
        reason: !tokenHash
          ? "missing_token"
          : typeParam
            ? "invalid_type"
            : "missing_type",
      })
    );
  }

  return NextResponse.redirect(new URL("/sign-in?error=confirm", request.url));
}
