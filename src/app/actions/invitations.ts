"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { InviteSchema } from "@/lib/validation/schemas";
import { generateToken, hashToken } from "@/lib/invitations/token";
import { sendEmail } from "@/lib/email/send";
import {
  buildInvitationEmail,
  invitationAcceptUrl,
} from "@/lib/email/invitation-email";

const INVITE_TTL_DAYS = 7;
const UNIQUE_VIOLATION = "23505";

export type InviteMemberState = { error?: string; sentTo?: string };

/**
 * Admin invites a person to their org by email. Creates a single-use, expiring
 * invitation and emails the accept link. Guarded by `canWrite` (only the org
 * admin can invite). Membership is granted later, at accept time.
 *
 * We don't pre-check whether the email already belongs to a member: that mapping
 * lives in `auth.users` (not exposed to the service-role data client), and the
 * accept-time `unique(memberships.user_id)` guard already rejects double-joins.
 * Duplicate *pending* invites are rejected by the partial unique index.
 */
export async function inviteMember(
  _prev: InviteMemberState,
  formData: FormData
): Promise<InviteMemberState> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!canWrite || !orgId) {
    return { error: "Only team admins can invite members." };
  }

  const parsed = InviteSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter a valid email address." };
  }
  const { email } = parsed.data;

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();

  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: invite, error } = await supabaseAdmin
    .from("invitations")
    .insert({
      org_id: orgId,
      email,
      token_hash: hashToken(token),
      invited_by: userId,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !invite) {
    if (error?.code === UNIQUE_VIOLATION) {
      return { error: "An invitation is already pending for this email." };
    }
    console.error("invitation insert failed", error);
    return { error: "Could not send the invitation. Please try again." };
  }

  try {
    await sendEmail(
      buildInvitationEmail({
        to: email,
        orgName: org?.name ?? "your team",
        acceptUrl: invitationAcceptUrl(token),
      })
    );
  } catch (sendError) {
    // The email is the whole point — if it didn't go out, roll the invite back
    // so the admin can simply retry rather than fighting the pending-unique index.
    console.error("invitation email failed", sendError);
    await supabaseAdmin.from("invitations").delete().eq("id", invite.id);
    return { error: "Could not send the invitation email. Please try again." };
  }

  await track({ name: "invitation.sent", props: { team_id: orgId } }, { userId });
  revalidatePath("/settings/team");

  return { sentTo: email };
}

/**
 * Admin revokes a pending invitation. Scoped to the caller's org so an admin
 * can't delete another team's invite by id. Form action — revalidates the list.
 */
export async function revokeInvitation(formData: FormData): Promise<void> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!canWrite || !orgId) return;

  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return;

  const { error } = await supabaseAdmin
    .from("invitations")
    .delete()
    .eq("id", invitationId)
    .eq("org_id", orgId);

  if (error) {
    console.error("invitation revoke failed", error);
    return;
  }

  await track({ name: "invitation.revoked", props: { team_id: orgId } }, { userId });
  revalidatePath("/settings/team");
}

export type AcceptInvitationState = { error?: string };

/**
 * Invitee accepts an invitation and receives a `member` membership. Entry points
 * are the emailed `/invite/accept` link (signed-in) and the onboarding page
 * (post sign-up). Validates email match against the *verified* session email,
 * then claims the invite atomically (`accepted_at is null` guard) so it's
 * single-use, and only then inserts the membership.
 */
export async function acceptInvitation(
  _prev: AcceptInvitationState,
  formData: FormData
): Promise<AcceptInvitationState> {
  const { userId, email } = await getAuthContext();
  if (!userId) redirect("/sign-in");

  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return { error: "This invitation could not be found." };

  const { data: invite } = await supabaseAdmin
    .from("invitations")
    .select("id, org_id, role, email, expires_at, accepted_at")
    .eq("id", invitationId)
    .maybeSingle();

  if (!invite) return { error: "This invitation could not be found." };
  if (invite.accepted_at) return { error: "This invitation has already been used." };
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { error: "This invitation has expired." };
  }
  if (invite.email !== email?.toLowerCase()) {
    return {
      error: `This invitation is for ${invite.email}. Sign in with that email to accept it.`,
    };
  }

  // Claim the invite atomically so concurrent accepts can't both succeed.
  const { data: claimed } = await supabaseAdmin
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invitationId)
    .is("accepted_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return { error: "This invitation has already been used." };

  const { error: membershipError } = await supabaseAdmin
    .from("memberships")
    .insert({ org_id: invite.org_id, user_id: userId, role: invite.role });

  if (membershipError) {
    // Un-claim so a recoverable failure doesn't burn the invite.
    await supabaseAdmin
      .from("invitations")
      .update({ accepted_at: null })
      .eq("id", invitationId);

    if (membershipError.code === UNIQUE_VIOLATION) {
      // Single-owner today: a user belongs to exactly one org. #52 lifts this.
      return {
        error: "You already belong to a team. Switching teams isn't supported yet.",
      };
    }
    console.error("membership insert failed on accept", membershipError);
    return { error: "Could not accept the invitation. Please try again." };
  }

  await track(
    { name: "invitation.accepted", props: { team_id: invite.org_id } },
    { userId }
  );

  redirect("/rubrics");
}
