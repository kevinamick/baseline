"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";
import { resolveOnboardingRedirect } from "@/lib/auth/post-auth-redirect";
import { isOAuthProvider } from "@/lib/auth/oauth";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import {
  EmailSchema,
  SignInSchema,
  SignUpSchema,
  PasswordSchema,
  AccessCodeSchema,
} from "@/lib/validation/schemas";
import { firstIssueMessage } from "@/lib/validation/first-issue";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { trustedClientIp } from "@/lib/rate-limit/client-ip";
import { currentUserLocale } from "@/lib/email/i18n";
import { isSignupGated } from "@/lib/analytics/signup-gate";
import { hasPendingInvitation } from "@/lib/invitations/pending";
import {
  claimAccessCode,
  releaseAccessCodeClaim,
  recordAccessCodeRedemption,
  type AccessCodeClaimStatus,
} from "@/lib/access-codes/redeem";
import { mintSignupPass, isSignupPassRejection } from "@/lib/signup-passes/mint";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// A failed claim's RPC-level status collapses to the three user-facing
// buckets the sign-up form translates (ADR-0017, #426): an unrecognized code
// and a claim RPC failure (fail-closed) both read as "invalid" — neither is
// distinguishable from the other without leaking whether a guessed code
// exists, and a transient RPC error must never look more actionable than a
// typo.
function accessCodeErrorFor(status: AccessCodeClaimStatus): "invalid" | "expired" | "exhausted" {
  if (status === "expired") return "expired";
  if (status === "exhausted") return "exhausted";
  return "invalid";
}

export interface SignInState {
  error?: string;
}

export interface SignUpState {
  error?: string;
  /** Set once the confirmation email has been sent — the form switches to a
   *  "check your email" view (no session exists until the link is clicked). */
  emailSent?: boolean;
  /** Set when the launch-phase Access Code gate (ADR-0017, #425) refused this
   *  submission: gated, no pending Invitation matches the submitted email,
   *  and no code was submitted either. The form renders the translated
   *  invite-only refusal copy for this rather than a raw `error` string. */
  gated?: boolean;
  /** Set when a submitted Access Code (ADR-0017, #426) could not be claimed —
   *  distinct from `gated` (no code at all) and from a raw Supabase `error`.
   *  `"invalid"` covers an unrecognized code (including a claim RPC failure,
   *  fail-closed). The form renders a distinct translated message per status. */
  accessCodeError?: "invalid" | "expired" | "exhausted";
  /** Set when a fail-closed refusal fires while the gate is NOT up — a
   *  transient signup-pass mint/DB failure or an anomalous hook rejection
   *  (#489). The form renders a generic retryable error, never the invite-only
   *  copy, which would be wrong on an open-registration form with no code
   *  field. */
  retryable?: boolean;
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
      error: firstIssueMessage(parsed.error, "Email and password are required."),
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
    // Deferred to after() (high-volume, attacker-reachable path): never buy a
    // failed login attempt a synchronous PostHog round-trip, but still let the
    // runtime await the warn-level flush so a serverless freeze can't drop it.
    // Logs the domain only, never the full address, matching the analytics PII
    // posture. Surfaces credential stuffing / brute-force bursts and Supabase
    // auth outages in queryable Logs.
    after(() =>
      log.warn("Sign-in failed", {
        event: "auth.sign_in_failed",
        email_domain: email.split("@")[1],
        error,
      })
    );
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
      error: firstIssueMessage(parsed.error, "Email and password are required."),
    };
  }
  const { email, password } = parsed.data;

  // Per-IP rate limit (ADR-0010). Generic 429 over the limit. The anti-enumeration
  // fake-success below is preserved — this only caps signup volume per source IP.
  if (await checkLimit("signUp", "ip", await trustedClientIp())) {
    return { error: rateLimitMessage() };
  }

  // Launch-phase Access Code gate (ADR-0017, #425 + #426). While the gate is
  // up, a pending Invitation matching the submitted email still bypasses
  // everything unconditionally (#425) — no code required, none consumed, even
  // if one was submitted alongside an invited email. Otherwise a valid Access
  // Code is the only other way in: claimed ATOMICALLY (one guarded write,
  // `claim_access_code`) BEFORE any Supabase user is created, and released
  // again below if user creation itself fails. This calls the same
  // isSignupGated() the /sign-up page reads server-side, so the two can never
  // disagree about whether the gate is currently up. Gating never affects
  // sign-in or an existing account, only this creation path.
  let claimedAccessCodeId: string | null = null;
  // Resolved once and reused: the gate state also decides the fail-closed
  // copy below (invite-only when gated, generic-retry when not, #489).
  const gated = await isSignupGated();
  if (gated) {
    if (!(await hasPendingInvitation(email))) {
      const codeParsed = AccessCodeSchema.safeParse(formData.get("accessCode") ?? "");
      if (!codeParsed.success) {
        // No code submitted (or a pathological one) — the sign-up form's
        // accessCode field isn't HTML-`required` (an invited visitor must
        // still get through with none), so this is the expected refusal for
        // an uninvited, code-less visitor. Same generic invite-only message
        // as before Access Codes existed.
        after(() =>
          log.warn("Sign-up refused: access gate, no pending invitation or code", {
            event: "auth.sign_up_gated",
            email_domain: email.split("@")[1],
          })
        );
        return { gated: true };
      }

      const claim = await claimAccessCode(codeParsed.data);
      if (!claim.claimed) {
        after(() =>
          log.warn("Sign-up refused: access code not claimable", {
            event: "auth.sign_up_access_code_refused",
            email_domain: email.split("@")[1],
            status: claim.status,
          })
        );
        return { accessCodeError: accessCodeErrorFor(claim.status) };
      }
      claimedAccessCodeId = claim.accessCodeId;
    }
  }

  // Signup pass (#487, ADR-0017): minted on EVERY app-originated sign-up —
  // gated or not — after all the checks above passed and immediately before
  // supabase.auth.signUp. GoTrue's before_user_created hook refuses any user
  // creation whose email + nonce don't match a valid pass, which is what
  // closes the direct /auth/v1/signup + /auth/v1/otp REST bypass; the hook's
  // only rule is "the app was the front door", so this is load-bearing for
  // ungated sign-ups too. The returned nonce is threaded into options.data
  // below so GoTrue carries it to the hook (email-only binding would let an
  // attacker race a victim's pass, #489). A mint failure fails CLOSED (and
  // hands back a claimed Access Code slot — no account will result).
  const signupNonce = await mintSignupPass(email);
  if (!signupNonce) {
    if (claimedAccessCodeId) await releaseAccessCodeClaim(claimedAccessCodeId);
    after(() =>
      log.warn("Sign-up refused: signup pass mint failed", {
        event: "auth.sign_up_pass_mint_failed",
        email_domain: email.split("@")[1],
      })
    );
    // Gated → the generic invite-only refusal (the form already shows the
    // gated UI). Ungated → a transient mint/DB blip must NOT show invite-only
    // on an open-registration form with no code field; surface a retryable
    // error instead (#489).
    return gated ? { gated: true } : { retryable: true };
  }

  // Stash the signup-time locale in user_metadata so the confirmation email
  // GoTrue sends (supabase/templates/confirmation.html) renders in it (#247).
  // This is the recipient's only known preference for a brand-new account.
  const locale = await currentUserLocale();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { locale, signup_nonce: signupNonce } },
  });
  if (error) {
    // User creation itself failed — hand the claimed slot back (ADR-0017: the
    // claim releases only when there is genuinely no new account).
    if (claimedAccessCodeId) await releaseAccessCodeClaim(claimedAccessCodeId);
    after(() =>
      log.warn("Sign-up failed", {
        event: "auth.sign_up_failed",
        email_domain: email.split("@")[1],
        error,
      })
    );
    // A pass-hook rejection should be unreachable here (the pass was just
    // minted), so reaching it means something is genuinely wrong between the
    // mint and GoTrue. Map it to the generic gated refusal rather than
    // echoing the raw 403 — fail-closed and indistinguishable from a normal
    // refusal, no oracle for probers (#487). Gate-aware like the mint-failure
    // path so an ungated form never shows invite-only copy (#489).
    if (isSignupPassRejection(error)) return gated ? { gated: true } : { retryable: true };
    return { error: error.message };
  }

  // A genuinely new signup. When confirmations are on and the email is already
  // registered, Supabase returns an obfuscated user with an empty `identities`
  // array (anti-enumeration) and no error — guard on identities so we don't fire
  // a signup event for an existing account. This replaces the server-side Clerk
  // `user.created` webhook the cutover removed (#56).
  const isNewUser = (data.user?.identities?.length ?? 0) > 0;
  if (!isNewUser) {
    // Anti-enumeration path: no new account was actually created, so a
    // claimed slot must go back (ADR-0017) — an over-admitting cap on a code
    // that goes viral would be a broken cap, but a slot lost to a genuinely
    // abandoned sign-up (below) is a shrug.
    if (claimedAccessCodeId) await releaseAccessCodeClaim(claimedAccessCodeId);
  }
  if (isNewUser) {
    // An unconfirmed-but-created account KEEPS its claimed slot (ADR-0017) —
    // no release path below this point for a real new user, confirmed or not.
    if (claimedAccessCodeId) {
      await recordAccessCodeRedemption(claimedAccessCodeId, data.user!.id);
    }
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
      error: firstIssueMessage(parsed.error, "Enter a valid email address."),
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
      error: firstIssueMessage(parsed.error, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`),
    };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    after(() =>
      log.warn("Password reset failed", {
        event: "auth.password_reset_failed",
        error,
      })
    );
    return { error: error.message };
  }

  // Password reset is reached after a recovery flow already established the
  // session. The user is already in the app — go straight to /dashboard; the
  // dashboard's own `if (!orgId) redirect("/onboarding")` backstop handles
  // the no-org case if it arises.
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
    // The user only sees a generic `?error=oauth`; the reason is otherwise lost.
    // Don't echo the raw submitted value (untrusted, unbounded) — just the cause.
    after(() =>
      log.warn("OAuth sign-in failed", {
        event: "auth.oauth_failed",
        reason: "unsupported_provider",
      })
    );
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
    after(() =>
      log.warn("OAuth sign-in failed", {
        event: "auth.oauth_failed",
        reason: error ? "provider_error" : "no_authorize_url",
        provider,
        error: error ?? undefined,
      })
    );
    redirect("/sign-in?error=oauth");
  }

  redirect(data.url);
}
