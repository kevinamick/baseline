"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import type { Role } from "@/lib/auth/context";

const MANAGEABLE_ROLES: Role[] = ["admin", "member"];

/**
 * Count the org's admins via a head-only `exact` count. Used by the last-admin
 * guard so the team can never be left with no one who can manage it.
 */
async function adminCount(orgId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("role", "admin");
  return count ?? 0;
}

/**
 * Load a member's current role, scoped to the caller's org so an admin can't
 * reach into another team by user id.
 */
async function memberRole(
  orgId: string,
  userId: string
): Promise<Role | null> {
  const { data } = await supabaseAdmin
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.role as Role | undefined) ?? null;
}

/**
 * Promote or demote a member (admin ↔ member). Admin-only and org-scoped. The
 * last-admin guard refuses to demote the org's only admin, so a team always
 * keeps someone who can manage it. Plain form action — the members list in the
 * UI hides the invalid control; this guard is the server-side backstop.
 */
export async function changeMemberRole(formData: FormData): Promise<void> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!canWrite || !orgId) return;

  const targetUserId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!targetUserId || !MANAGEABLE_ROLES.includes(role as Role)) return;
  const newRole = role as Role;

  const current = await memberRole(orgId, targetUserId);
  if (!current || current === newRole) return;

  // Demoting the last admin would orphan the team's management. Refuse it.
  if (newRole === "member" && (await adminCount(orgId)) <= 1) return;

  const { error } = await supabaseAdmin
    .from("memberships")
    .update({ role: newRole })
    .eq("org_id", orgId)
    .eq("user_id", targetUserId);

  if (error) {
    await log.error("membership role change failed", {
      event: "membership.role_change_failed",
      team_id: orgId,
      target_user_id: targetUserId,
      role: newRole,
      error,
    });
    return;
  }

  await track(
    { name: "membership.role_changed", props: { team_id: orgId, role: newRole } },
    { userId }
  );
  revalidatePath("/settings/team");
}

/**
 * Remove a member from the org. Admin-only and org-scoped. The last-admin guard
 * refuses to remove the org's only admin (mirrors the demote guard).
 */
export async function removeMember(formData: FormData): Promise<void> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!canWrite || !orgId) return;

  const targetUserId = String(formData.get("userId") ?? "");
  if (!targetUserId) return;

  const current = await memberRole(orgId, targetUserId);
  if (!current) return;
  if (current === "admin" && (await adminCount(orgId)) <= 1) return;

  const { error } = await supabaseAdmin
    .from("memberships")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", targetUserId);

  if (error) {
    await log.error("membership removal failed", {
      event: "membership.remove_failed",
      team_id: orgId,
      target_user_id: targetUserId,
      error,
    });
    return;
  }

  await track(
    { name: "membership.removed", props: { team_id: orgId } },
    { userId }
  );
  revalidatePath("/settings/team");
}
