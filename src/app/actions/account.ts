"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { EmailSchema } from "@/lib/validation/schemas";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

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
  /** Set once the new password has been saved. */
  saved?: boolean;
}

/**
 * Update the display name, stored on the auth user's metadata under `name`
 * (the field `user-identifier.tsx` already reads for analytics). An empty value
 * clears it.
 */
export async function updateProfile(
  _prev: ProfileState,
  formData: FormData
): Promise<ProfileState> {
  const name = String(formData.get("name") ?? "").trim();

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
 */
export async function changeEmail(
  _prev: EmailState,
  formData: FormData
): Promise<EmailState> {
  const parsed = EmailSchema.safeParse(formData.get("email") ?? "");
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter a new email address." };
  }
  const email = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ email });
  if (error) {
    return { error: error.message };
  }

  return { emailSent: true };
}

/**
 * Set a new password for the current session's user. `secure_password_change`
 * is off (config.toml), so no recent-login re-auth is required; the current
 * session stays valid.
 */
export async function changePassword(
  _prev: PasswordState,
  formData: FormData
): Promise<PasswordState> {
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

  return { saved: true };
}
