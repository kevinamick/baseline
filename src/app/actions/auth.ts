"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";
import { resolveOnboardingRedirect } from "@/lib/auth/post-auth-redirect";
import { isOAuthProvider } from "@/lib/auth/oauth";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { EmailSchema, SignInSchema, SignUpSchema, PasswordSchema } from "@/lib/validation/schemas";
import { track } from "@/lib/analytics/server";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { trustedClientIp } from "@/lib/rate-limit/client-ip";
import { currentUserLocale } from "@/lib/email/i18n";

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
  // Validate before any auth-provider call (defense in depth + UX). Sign-in only
  // requires a well-formed email and a non-empty password — NOT the full signup
  // password policy, so a pre-existing account with a shorter password can't be
  // locked out by a length gate. Supabase stays the authority on the credential.
  const parsed = SignInSchema.safeParse({
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Email and password are required.",
    };
  }
  const { email, password } = parsed.data;
  // Where to land after sign-in. Defaults to /dashboard; an invite link routes
  // a signed-out invitee here as `?next=/invite/accept?token=…`. Constrained to
  // a same-origin path so it can't be abused as an open redirect.
  const next = safeNext(formData.get("next") as string | null, APP_URL);

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
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  // Post-auth onboarding redirect (#355): if the user has no org membership,
  // route them to /onboarding immediately instead of deferring to /dashboard.
  redirect(await resolveOnboardingRedirect(data.user, next));
}

export async function signUp(
  _prev: SignUpState,
  formData: FormData
): Promise<SignUpState> {
  // Validate before any auth-provider call (defense in depth + UX). Sign-up
  // enforces the full policy: a valid email and a password meeting the shared
  // min-length (single-sourced with Supabase's minimum_password_length).
  const parsed = SignUpSchema.safeParse({
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Email and password are required.",
    };
  }
  const { email, password } = parsed.data;

  // Per-IP rate limit (ADR-0010). Generic 429 over the limit. The anti-enumeration
  // fake-success below is preserved — this only caps signup volume per source IP.
  if (await checkLimit("signUp", "ip", await trustedClientIp())) {
    return { error: rateLimitMessage() };
  }

  // Stash the signup-time locale in user_metadata so the confirmation email
  // GoTrue sends (supabase/templates/confirmation.html) renders in it (#247).
  // This is the recipient's only known preference for a brand-new account.
  const locale = await currentUserLocale();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { locale } },
  });
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
    // Post-auth onboarding redirect (#355): if the user has no org membership,
    // route them to /onboarding immediately instead of deferring to /dashboard.
    redirect(await resolveOnboardingRedirect(data.user, "/dashboard"));
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

  // Same full password policy as sign-up, single-sourced via PasswordSchema so the
  // min-length rule and its message can't drift between the two set-password paths.
  const parsed = PasswordSchema.safeParse(password);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords don't match." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: error.message };
  }

  // Post-auth onboarding redirect (#355): if the user has no org membership,
  // route them to /onboarding immediately instead of deferring to /dashboard.
  redirect(await resolveOnboardingRedirect(data.user, "/dashboard"));
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
