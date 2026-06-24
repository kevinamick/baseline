"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/active-org";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { InviteSchema } from "@/lib/validation/schemas";
import { getBillingState, isEndedStatus } from "@/lib/billing/state";
import { countMembers } from "@/lib/billing/seats";
import { PLANS } from "@/lib/billing/plans";
import { generateToken, hashToken } from "@/lib/invitations/token";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { sendEmail } from "@/lib/email/send";
import {
  buildInvitationEmail,
  invitationAcceptUrl,
} from "@/lib/email/invitation-email";
import { resolveEmailLocale } from "@/lib/email/i18n";

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
 * accept-time `(org_id, user_id)` primary key already rejects re-joining the same
 * org. Duplicate *pending* invites are rejected by the partial unique index.
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

  // Per-team rate limit (ADR-0010): throttles invite-email spam. Generic 429
  // over the limit. The seat cap below still bounds the *total* invites a team
  // can have outstanding; this only caps the rate, and runs first so a burst is
  // rejected before any billing/DB work.
  if (await checkLimit("inviteMember", "team", orgId)) {
    return { error: rateLimitMessage() };
  }

  // Seat cap at the source (#182): a plan with a seat limit blocks invites
  // once members + pending invites would exceed it. Free's limit is 1, so a
  // Free team can never invite at all without upgrading.
  const billing = await getBillingState(orgId);
  const seatLimit = PLANS[billing.plan].seatLimit;
  if (seatLimit != null) {
    const [members, { count: pending }] = await Promise.all([
      countMembers(orgId),
      supabaseAdmin
        .from("invitations")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .is("accepted_at", null),
    ]);
    if (members + (pending ?? 0) >= seatLimit) {
      // A LIVE subscription in payment trouble floors the quota tier to Free
      // too — but that team's remedy is fixing payment, not "upgrading".
      const paymentTrouble =
        billing.status != null && !billing.active && !isEndedStatus(billing.status);
      return {
        error: paymentTrouble
          ? `Your team is limited to the Free quota (${seatLimit} seat${seatLimit === 1 ? "" : "s"}) until the payment goes through — update your payment method on the Billing page.`
          : `The ${PLANS[billing.plan].name} plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"} — upgrade to invite teammates.`,
      };
    }
  }

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
    await log.error("invitation insert failed", {
      event: "invitation.create_failed",
      team_id: orgId,
      error,
    });
    return { error: "Could not send the invitation. Please try again." };
  }

  // Resolve the email locale off-request (#241): the invitee has no stored
  // preference, so fall back to the inviting admin's active locale (their
  // NEXT_LOCALE cookie, set by the i18n middleware), then to the default.
  const cookieStore = await cookies();
  const locale = resolveEmailLocale({
    recipientLocale: null,
    inviterLocale: cookieStore.get("NEXT_LOCALE")?.value ?? null,
  });

  try {
    await sendEmail(
      await buildInvitationEmail({
        to: email,
        orgName: org?.name ?? "your team",
        acceptUrl: invitationAcceptUrl(token),
        locale,
      })
    );
  } catch (sendError) {
    // The email is the whole point — if it didn't go out, roll the invite back
    // so the admin can simply retry rather than fighting the pending-unique index.
    await log.error("invitation email failed", {
      event: "invitation.email_failed",
      team_id: orgId,
      error: sendError,
    });
    const { error: cleanupError } = await supabaseAdmin
      .from("invitations")
      .delete()
      .eq("id", invite.id);
    if (cleanupError) {
      await log.error("invitation cleanup failed after email send failure; invite left pending", {
        event: "invitation.cleanup_failed",
        team_id: orgId,
        invitation_id: invite.id,
        error: cleanupError,
      });
      return { error: "Could not send the invitation email. Please contact support if this persists." };
    }
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
    await log.error("invitation revoke failed", {
      event: "invitation.revoke_failed",
      invitation_id: invitationId,
      error,
    });
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
    // Un-claim so a recoverable failure doesn't burn the invite. If the un-claim
    // itself fails, log it — the invite is left stamped and needs attention.
    const { error: unclaimError } = await supabaseAdmin
      .from("invitations")
      .update({ accepted_at: null })
      .eq("id", invitationId);
    if (unclaimError) {
      await log.error("invite un-claim failed; invite left stamped", {
        event: "invitation.unclaim_failed",
        invitation_id: invitationId,
        error: unclaimError,
      });
    }

    if (membershipError.code === UNIQUE_VIOLATION) {
      // A user can belong to many orgs now (#52); the only unique violation left
      // is the (org_id, user_id) PK — they're already in *this* org.
      return { error: "You're already a member of this team." };
    }
    await log.error("membership insert failed on accept", {
      event: "invitation.accept_failed",
      invitation_id: invitationId,
      team_id: invite.org_id,
      error: membershipError,
    });
    return { error: "Could not accept the invitation. Please try again." };
  }

  await track(
    { name: "invitation.accepted", props: { team_id: invite.org_id } },
    { userId }
  );

  // Switch the invitee into the org they just joined so they land in it (#52).
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, invite.org_id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  redirect("/rubrics");
}
