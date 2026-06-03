"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  redirect("/dashboard");
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
