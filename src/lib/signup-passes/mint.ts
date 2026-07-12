import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";

/**
 * Signup passes (#487, ADR-0017): the app-minted, short-lived, single-use
 * token that a `before_user_created` GoTrue auth hook
 * (supabase/migrations/20260712000000_signup_passes.sql) demands before it
 * lets ANY user creation through — closing the direct /auth/v1/signup REST
 * bypass of the launch sign-up gate.
 *
 * `signUp` (src/app/actions/auth.ts) mints one on EVERY app-originated
 * sign-up, gated or not, AFTER all its existing checks pass (rate limit →
 * gate flag → Invitation bypass / Access Code claim) and immediately before
 * `supabase.auth.signUp()`. The hook consumes it atomically; a sign-up that
 * never reaches user creation (duplicate email, abandoned submit) leaves an
 * unconsumed row that simply expires and is purged by a later mint.
 *
 * The hook itself never reads the gate flag and never checks Invitations or
 * Access Codes — "account creation must originate from the app" is its only
 * rule, so gate-lift needs no hook change.
 */

/**
 * The exact message the hook's 403 rejection carries — must stay
 * byte-identical to `v_reject` in the migration above. The signUp action
 * matches on it to map a hook rejection (which should be unreachable for
 * app-originated sign-ups, since the app just minted a pass) to the same
 * generic gated refusal an uninvited visitor gets, rather than echoing a raw
 * provider error that would out the pass mechanism.
 */
export const SIGNUP_PASS_REJECTION_MESSAGE = "Sign-up is not available.";

/**
 * True when a `supabase.auth.signUp()` error is the signup-pass hook's
 * rejection rather than an ordinary provider error.
 */
export function isSignupPassRejection(error: {
  message: string;
  status?: number;
}): boolean {
  return error.status === 403 && error.message === SIGNUP_PASS_REJECTION_MESSAGE;
}

// Consumed/expired rows are dead weight after this long; each mint sweeps
// them opportunistically (no pg_cron job needed at sign-up volume). Generous
// relative to the 10-minute pass TTL so a row is never purged while a signUp
// call could still legitimately consume it.
const PURGE_AFTER_MS = 60 * 60 * 1000;

/**
 * Mint a signup pass for `email` (already normalized by EmailSchema). Returns
 * false on any failure — the caller must then REFUSE the sign-up (fail
 * closed): without a pass, GoTrue's hook would reject the creation anyway,
 * and refusing here keeps the user-facing response the generic gated refusal
 * instead of a leaked provider error.
 */
export async function mintSignupPass(email: string): Promise<boolean> {
  // Opportunistic purge of long-dead rows (best-effort: a failure here must
  // never block the mint itself, so errors are logged and swallowed).
  const cutoff = new Date(Date.now() - PURGE_AFTER_MS).toISOString();
  const { error: purgeError } = await supabaseAdmin
    .from("signup_passes")
    .delete()
    .lt("expires_at", cutoff);
  if (purgeError) {
    await log.warn("signup pass purge failed", {
      event: "signup_pass.purge_failed",
      error: purgeError,
    });
  }

  const { error } = await supabaseAdmin.from("signup_passes").insert({ email });
  if (error) {
    await log.error("signup pass mint failed", {
      event: "signup_pass.mint_failed",
      email_domain: email.split("@")[1],
      error,
    });
    return false;
  }
  return true;
}
