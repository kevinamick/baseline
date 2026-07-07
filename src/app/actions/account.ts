"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { EmailSchema } from "@/lib/validation/schemas";
import { firstIssueMessage } from "@/lib/validation/first-issue";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { getAuthContext } from "@/lib/auth/context";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { currentUserLocale } from "@/lib/email/i18n";

// Account self-service over Supabase Auth (#53), replacing Clerk's account
// portal. Every flow operates on the *current* session's user via
// `supabase.auth.updateUser` — there is no userId parameter to forge, the
// cookie-bound client is the authorization. Mirrors the void/state-returning
// style of the sign-in/up actions in ./auth.ts.

export interface ProfileState {
  error?: string;
  /** Set once the display name has been saved — the form shows a confirmation. */
  saved?: boolean;
}

export interface EmailState {
  error?: string;
  /** Set once the change has been requested — confirmation links are emailed to
   *  both the current and the new address before the change takes effect. */
  emailSent?: boolean;
}

export interface PasswordState {
  error?: string;
  /** Set once the reauthentication code has been emailed — the form reveals the
   *  code field. Stays set on subsequent validation errors so the field
   *  persists. */
  codeSent?: boolean;
  /** Set once the new password has been saved. */
  saved?: boolean;
}

/**
 * Update the display name, stored on the auth user's metadata under `name`
 * (the field `user-identifier.tsx` already reads for analytics). An empty value
 * clears it.
 */
const MAX_DISPLAY_NAME_LENGTH = 100;

export async function updateProfile(
  _prev: ProfileState,
  formData: FormData
): Promise<ProfileState> {
  const name = String(formData.get("name") ?? "").trim();
  if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    return { error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.` };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ data: { name } });
  if (error) {
    return { error: error.message };
  }

  // The account page reads the name from the user on the server, so re-render it.
  revalidatePath("/settings/account");
  return { saved: true };
}

/**
 * Request an email change. With double-confirmation enabled (config.toml), this
 * emails a verification link to *both* the current and the new address; the
 * change only lands once both are confirmed. The links route through
 * /auth/confirm with `type=email_change`. No session change happens here.
 *
 * Auth hardening (#74): that current-address confirmation *is* the initiator
 * gate — a stolen session can kick off a change but can't complete it without
 * also clicking the link sent to the real owner's inbox, so no extra re-auth is
 * layered on here.
 */
export async function changeEmail(
  _prev: EmailState,
  formData: FormData
): Promise<EmailState> {
  const parsed = EmailSchema.safeParse(formData.get("email") ?? "");
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Enter a new email address.") };
  }
  const email = parsed.data;

  // Per-user rate limit (ADR-0010): caps confirmation-email spam from one
  // account. Authenticated surface — a plain visible 429, nothing to enumerate.
  // Keyed on the session user; an unauthenticated caller has no key and falls
  // through to updateUser, which rejects it for the missing session anyway.
  const { userId } = await getAuthContext();
  if (userId && (await checkLimit("changeEmail", "user", userId))) {
    return { error: rateLimitMessage() };
  }

  // Refresh the stored locale alongside the change so the email-change
  // confirmation (sent to both the current and new address) renders in the
  // user's active locale (#247). `data` merges into user_metadata, leaving
  // other keys (e.g. `name`) intact.
  const locale = await currentUserLocale();
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ email, data: { locale } });
  if (error) {
    return { error: error.message };
  }

  return { emailSent: true };
}

/**
 * Change the current user's password behind an email-confirmation gate (#74).
 * `secure_password_change` is on (config.toml), and this action always drives
 * Supabase's reauthentication flow rather than setting the password directly:
 *
 *   1. `intent=send-code` → `reauthenticate()` emails a one-time code to the
 *      account's current address (supabase/templates/reauthentication.html).
 *   2. `intent=submit` → the user supplies that code as the `nonce` and
 *      `updateUser({ password, nonce })` lands the new password.
 *
 * This closes the "unattended logged-in browser" vector — anyone using this form
 * needs the code from the owner's inbox. Residual limit (#81): GoTrue only
 * *enforces* the nonce for sessions older than 24h, so a token hijacked within
 * that window could still bypass this by calling GoTrue's PUT /user directly.
 * That's a provider ceiling the UI can't fix; the residual risk is ACCEPTED and
 * documented in docs/adr/0012-accept-residual-password-change-reauth-gap.md (the
 * GoTrue password_changed notification was evaluated and does NOT fire on our
 * version — read the ADR before re-attempting a fix here).
 *
 * Validation errors after step 1 keep `codeSent` set so the code field — and the
 * already-typed password — stay on screen.
 */
export async function changePassword(
  _prev: PasswordState,
  formData: FormData
): Promise<PasswordState> {
  const supabase = await createClient();

  if (formData.get("intent") === "send-code") {
    // Refresh the stored locale before GoTrue renders the reauthentication code
    // email (supabase/templates/reauthentication.html) from user_metadata (#247).
    // Best-effort: a missing session surfaces below on reauthenticate() anyway.
    await supabase.auth.updateUser({ data: { locale: await currentUserLocale() } });
    const { error } = await supabase.auth.reauthenticate();
    if (error) {
      return { error: error.message };
    }
    return { codeSent: true };
  }

  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const nonce = String(formData.get("code") ?? "").trim();

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      codeSent: true,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password !== confirmPassword) {
    return { codeSent: true, error: "Passwords don't match." };
  }
  if (!nonce) {
    return {
      codeSent: true,
      error: "Enter the confirmation code we emailed you.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password, nonce });
  if (error) {
    return { codeSent: true, error: error.message };
  }

  return { saved: true };
}
