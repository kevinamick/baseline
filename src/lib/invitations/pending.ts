import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";

/**
 * Is there a pending, unexpired Invitation for this email? Backs the
 * launch-phase sign-up gate (ADR-0017, #425): while `signup-access-code-gate` is
 * on, only an emailed Invitation (no Access Code yet — that ships in a later
 * slice) lets someone create an account without one.
 *
 * `email` must already be normalized (trimmed + lowercased, as `EmailSchema`
 * does) — Invitations are stored the same way (`InviteSchema` shares
 * `EmailSchema`, see src/lib/validation/schemas.ts), so this is a plain
 * equality match, not a case-insensitive one.
 *
 * `invitations` is not org-scoped from the caller's side (there's no org
 * context yet — the person hasn't signed up), so this reads across every
 * team's pending invites for the address, same as `acceptInvitation`
 * (src/app/actions/invitations.ts) already does when it looks an invite up by
 * email/token rather than by org.
 */
export async function hasPendingInvitation(email: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("invitations")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString());

  if (error) {
    await log.error("pending invitation lookup failed", {
      event: "invitation.gate_lookup_failed",
      error,
    });
    // Fail closed: a lookup error must not admit a sign-up the gate would
    // otherwise refuse.
    return false;
  }
  return (count ?? 0) > 0;
}
