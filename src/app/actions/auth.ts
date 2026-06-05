"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";

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

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return { error: error.message };
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
