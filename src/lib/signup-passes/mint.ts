import "server-only";
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";

/**
 * Signup passes (#487, ADR-0017): the app-minted, short-lived, single-use
 * token that a `before_user_created` GoTrue auth hook
 * (supabase/migrations/20260712000000_signup_passes.sql) demands before it
 * lets a self-service email creation through — closing the direct
 * /auth/v1/signup + /auth/v1/otp REST bypass of the launch sign-up gate.
 *
 * `signUp` (src/app/actions/auth.ts) mints one on EVERY app-originated
 * sign-up, gated or not, AFTER all its existing checks pass (rate limit →
 * gate flag → Invitation bypass / Access Code claim) and immediately before
 * `supabase.auth.signUp()`. The pass is bound to a per-request NONCE this
 * function generates and returns; the action threads that nonce into
 * `options.data` so GoTrue carries it into the hook's event payload
 * (`user_metadata`), and the hook consumes the pass only on an exact nonce
 * match for the email. Email-only binding would let a direct-REST attacker
 * racing a victim's sign-up consume the victim's pass and set the account
 * password (#489). The hook consumes it atomically; a sign-up that never
 * reaches user creation (duplicate email, abandoned submit) leaves an
 * unconsumed row that simply expires and is purged by a later mint.
 *
 * The hook itself never reads the gate flag and never checks Invitations or
 * Access Codes — "the app was the front door" is its only rule, so gate-lift
 * needs no hook change.
 */

export { SIGNUP_PASS_REJECTION_MESSAGE, isSignupPassRejection } from "./rejection";

// Consumed/expired rows are dead weight after this long; mints sweep them
// opportunistically (no pg_cron job needed at sign-up volume). Generous
// relative to the 10-minute pass TTL so a row is never purged while a signUp
// call could still legitimately consume it.
const PURGE_AFTER_MS = 60 * 60 * 1000;

// The purge reclaims the SAME dead rows no matter which mint triggers it, so
// running it on every sign-up just multiplies identical `DELETE`s. Fire it on a
// small random fraction of mints instead: at sign-up volume this still sweeps
// hour-dead rows promptly while cutting the delete write-load ~20x. Cheap,
// stateless, and needs no cron (#489).
const PURGE_SAMPLE_RATE = 0.05;

/**
 * Opportunistic purge of long-dead pass rows. Sampled (see PURGE_SAMPLE_RATE)
 * so it runs only occasionally, and deferred with `after()` (it is pure
 * best-effort housekeeping, independent of the mint) so it never adds a DB
 * round trip to the sign-up response's critical path, and — like the sibling
 * failure logs in `signUp` — keeps its warn-level PostHog flush off that path
 * too (#38, the attacker-reachable/high-volume `after()` rule).
 */
function purgeDeadPassesAfterResponse(): void {
  if (Math.random() >= PURGE_SAMPLE_RATE) return;
  after(async () => {
    const cutoff = new Date(Date.now() - PURGE_AFTER_MS).toISOString();
    const { error } = await supabaseAdmin
      .from("signup_passes")
      .delete()
      .lt("expires_at", cutoff);
    if (error) {
      await log.warn("signup pass purge failed", {
        event: "signup_pass.purge_failed",
        error,
      });
    }
  });
}

/**
 * Mint a signup pass for `email` (already normalized by EmailSchema). Returns
 * the per-request nonce the caller must thread into `supabase.auth.signUp`'s
 * `options.data` as `signup_nonce`, or `null` on any failure — in which case
 * the caller must REFUSE the sign-up (fail closed): without a pass, GoTrue's
 * hook would reject the creation anyway, and refusing here keeps the
 * user-facing response generic instead of a leaked provider error.
 */
export async function mintSignupPass(email: string): Promise<string | null> {
  purgeDeadPassesAfterResponse();

  const nonce = randomBytes(32).toString("base64url");
  const { error } = await supabaseAdmin
    .from("signup_passes")
    .insert({ email, nonce });
  if (error) {
    after(() =>
      log.error("signup pass mint failed", {
        event: "signup_pass.mint_failed",
        email_domain: email.split("@")[1],
        error,
      })
    );
    return null;
  }
  return nonce;
}
