import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Only permit redirects to a relative path within this app. Absolute URLs and
 * protocol-relative values ("//evil.com", "/\\evil.com") are rejected so a
 * crafted confirmation link can't bounce the user off-site (open redirect).
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/dashboard";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/dashboard";
  return raw;
}

/**
 * Email-confirmation callback. The confirmation email (see
 * supabase/templates/confirmation.html) links here with a `token_hash`; we
 * verify it server-side, which sets the session cookie, then land the user on
 * the dashboard. Listed as a public route in proxy.ts.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"));

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
