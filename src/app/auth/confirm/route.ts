import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";

// The OTP types this endpoint is allowed to verify. Email confirmation is all
// #46 ships; recovery/email_change/magiclink get added here when those flows
// land, so an attacker can't drive an unintended verification via ?type=.
const ALLOWED_OTP_TYPES = new Set<EmailOtpType>(["email"]);

/**
 * Email-confirmation callback. The confirmation email (see
 * supabase/templates/confirmation.html) links here with a `token_hash`; we
 * verify it server-side, which sets the session cookie, then land the user on
 * the dashboard. Listed as a public route in proxy.ts.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const typeParam = searchParams.get("type") as EmailOtpType | null;
  const type = typeParam && ALLOWED_OTP_TYPES.has(typeParam) ? typeParam : null;
  const next = safeNext(searchParams.get("next"), request.url);

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  return NextResponse.redirect(new URL("/sign-in?error=confirm", request.url));
}
