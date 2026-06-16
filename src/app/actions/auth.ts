"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";
import { isOAuthProvider } from "@/lib/auth/oauth";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { EmailSchema } from "@/lib/validation/schemas";
import { track } from "@/lib/analytics/server";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { trustedClientIp } from "@/lib/rate-limit/client-ip";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export interface SignInState {
  error?: string;
}

export interface SignUpState {
  error?: string;
  /** Set once the confirmation email has been sent — the form switches to a
   *  "check your email" view (no session exists until the link is clicked). */
  emailSent?: boolean;
}

export async function signIn(
  _prev: SignInState,
  formData: FormData
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // Where to land after sign-in. Defaults to /dashboard; an invite link routes
  // a signed-out invitee here as `?next=/invite/accept?token=…`. Constrained to
  // a same-origin path so it can't be abused as an open redirect.
  const next = safeNext(formData.get("next") as string | null, APP_URL);

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Dual-keyed rate limit (ADR-0010). Both checks return the same generic 429
  // copy on limit, and the per-email counter increments BEFORE the
  // (existence-aware) signInWithPassword, so a real and an unknown address are
  // throttled identically — no enumeration via differential limiting.
  if (await checkLimit("signIn", "ip", await trustedClientIp())) {
    return { error: rateLimitMessage() };
  }
  if (await checkLimit("signIn", "email", email)) {
    return { error: rateLimitMessage() };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  redirect(next);
}

export async function signUp(
  _prev: SignUpState,
  formData: FormData
): Promise<SignUpState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Per-IP rate limit (ADR-0010). Generic 429 over the limit. The anti-enumeration
  // fake-success below is preserved — this only caps signup volume per source IP.
  if (await checkLimit("signUp", "ip", await trustedClientIp())) {
    return { error: rateLimitMessage() };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return { error: error.message };
  }

  // A genuinely new signup. When confirmations are on and the email is already
  // registered, Supabase returns an obfuscated user with an empty `identities`
  // array (anti-enumeration) and no error — guard on identities so we don't fire
  // a signup event for an existing account. This replaces the server-side Clerk
  // `user.created` webhook the cutover removed (#56).
  if ((data.user?.identities?.length ?? 0) > 0) {
    await track(
      {
        name: "auth.user_signed_up",
        props: { user_id: data.user!.id, email_domain: email.split("@")[1] },
      },
      { userId: data.user!.id }
    );
  }

  // With confirmations disabled (a config.toml toggle that can drift on a hosted
  // project), signUp returns a live session — go straight in rather than showing
  // a "check your email" view that would strand a logged-in user.
  if (data.session) {
    redirect("/dashboard");
  }

  // Confirmation required — no session yet. The user confirms via the Mailpit
  // link, which hits /auth/confirm.
  return { emailSent: true };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export interface ResetRequestState {
  error?: string;
  /** Set once the recovery email has been sent — the form switches to a
   *  "check your email" view. Always set on a valid email (see below). */
  emailSent?: boolean;
}

/**
 * Request a password-reset ("forgot password") email. The recovery link
 * (supabase/templates/recovery.html) routes through /auth/confirm with
 * `type=recovery` and `next=/reset-password`, which establishes a short-lived
 * session and lands the user on the set-new-password form.
 *
 * We report success for any well-formed address whether or not it's registered,
 * so the response can't be used to enumerate which emails have accounts.
 */
export async function requestPasswordReset(
  _prev: ResetRequestState,
  formData: FormData
): Promise<ResetRequestState> {
  const parsed = EmailSchema.safeParse(formData.get("email") ?? "");
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Enter a valid email address.",
    };
  }

  // Dual-keyed rate limit (ADR-0010). The per-IP check is visible (generic 429
  // message); the per-email check silently drops — it returns the same success
  // as a sent email and skips the send, so it can't be used to enumerate which
  // addresses are registered. Both counters increment BEFORE Supabase's
  // (account-existence-aware) resetPasswordForEmail, so a real and an unknown
  // address are limited identically.
  if (await checkLimit("requestPasswordReset", "ip", await trustedClientIp())) {
    return { error: rateLimitMessage() };
  }
  if (await checkLimit("requestPasswordReset", "email", parsed.data)) {
    return { emailSent: true };
  }

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data);
  return { emailSent: true };
}

export interface ResetPasswordState {
  error?: string;
}

/**
 * Set a new password after following a recovery link. The link already
 * established the session (via /auth/confirm?type=recovery), so this updates the
 * current user the same way the account page does, then signs them into the app.
 */
export async function resetPassword(
  _prev: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: error.message };
  }

  redirect("/dashboard");
}

/**
 * Begin a social/OAuth sign-in. Validates the provider against the supported
 * list, asks Supabase for the provider's authorize URL (which sets the PKCE
 * verifier cookie via the SSR client), and redirects the browser there. The
 * provider returns to /auth/callback, which exchanges the code for a session.
 */
export async function signInWithOAuth(formData: FormData) {
  const provider = formData.get("provider");
  if (!isOAuthProvider(provider)) {
    redirect("/sign-in?error=oauth");
  }
  const next = safeNext(formData.get("next") as string | null, APP_URL);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${APP_URL}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error || !data.url) {
    redirect("/sign-in?error=oauth");
  }

  redirect(data.url);
}
