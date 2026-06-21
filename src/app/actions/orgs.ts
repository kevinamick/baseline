"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/active-org";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";

export type CreateOrgState = { error?: string };

const MAX_NAME_LENGTH = 80;

/**
 * Create an organization and make the current user its owner.
 *
 * Replaces Clerk's `useOrganizationList().createOrganization` + `setActive`.
 * The owner membership (`role='admin'`) is what `getAuthContext` reads back as
 * the active org, so the insert order is org → membership, both as the trusted,
 * verified user id. New teams land on Rubrics to author their first rubric.
 *
 * A user may own several orgs (#52 dropped the single-owner constraint): this is
 * both the first-team onboarding step and the "create another team" path, so the
 * freshly created org is set as the active one (cookie) before redirecting.
 */
export async function createOrganization(
  _prevState: CreateOrgState,
  formData: FormData
): Promise<CreateOrgState> {
  const { userId } = await getAuthContext();
  if (!userId) return { error: "You must be signed in to create a team." };

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  if (!name) return { error: "Team name is required." };
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `Team name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .insert({ name })
    .select("id")
    .single();

  if (orgError || !org) {
    await log.error("organization insert failed", {
      event: "team.create_failed",
      error: orgError,
    });
    return { error: "Could not create your team. Please try again." };
  }

  const { error: membershipError } = await supabaseAdmin
    .from("memberships")
    .insert({ org_id: org.id, user_id: userId, role: "admin" });

  if (membershipError) {
    await log.error("membership insert failed", {
      event: "team.creator_membership_failed",
      team_id: org.id,
      error: membershipError,
    });
    // Roll back the orphaned org so a retry starts clean. If the cleanup itself
    // fails, surface it — the org is left orphaned and needs manual attention.
    const { error: rollbackError } = await supabaseAdmin
      .from("organizations")
      .delete()
      .eq("id", org.id);
    if (rollbackError) {
      await log.error("org rollback failed; orphaned org", {
        event: "team.rollback_failed",
        team_id: org.id,
        error: rollbackError,
      });
    }
    return { error: "Could not create your team. Please try again." };
  }

  await track({ name: "team.created", props: { team_id: org.id } }, { userId });

  // Switch the creator into the org they just made so they land in it — for a
  // first team this is a no-op default, but when they already own a team it's
  // what makes "create another team" actually move them into the new one (#52).
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, org.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  // Back to onboarding: a freshly created Team is Free, so onboarding shows the
  // provider-key step (#184) before sending them into the app. A Team that's
  // somehow already paid falls straight through to /rubrics from there.
  redirect("/onboarding");
}

/**
 * Delete the caller's active organization, taking its memberships and all
 * org-scoped data with it.
 *
 * Replaces Clerk's `organization.deleted` webhook: that responsibility now lives
 * in the app. Every org-scoped table (`memberships`, `rubrics`, `connections`,
 * `schedules`, …) is FK'd to `organizations` with `on delete cascade`, so a
 * single delete of the org row removes the whole tree — and the DB triggers ride
 * the cascade too (a connection's Vault secret is cleaned up, and the
 * min-one-admin guard exempts cascade deletes since the org itself is going).
 *
 * Admin-only and scoped to the *active* org: `canWrite` is the active org's role
 * (admin), so a read-only member can't delete, and a forged target can't reach
 * another team — we only ever delete the org `getAuthContext` resolved.
 *
 * The `active_org` cookie pointed at the now-deleted org, so we clear it; the
 * caller is then routed by what's left — into a remaining team (Rubrics, where
 * `getAuthContext` falls back to their oldest membership) or to onboarding to
 * create their first team again.
 */
export async function deleteOrganization(): Promise<void> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId || !canWrite) return;

  const { error } = await supabaseAdmin
    .from("organizations")
    .delete()
    .eq("id", orgId);

  if (error) {
    await log.error("organization delete failed", {
      event: "team.delete_failed",
      team_id: orgId,
      error,
    });
    return;
  }

  await track({ name: "team.deleted", props: { team_id: orgId } }, { userId });

  // The cookie named the deleted org; drop it so getAuthContext stops trying to
  // resolve it and falls back to a remaining membership (or none).
  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_ORG_COOKIE);

  // Where to land depends on whether they still belong to any team. Only an
  // explicit zero means "no teams left" → onboarding; a null count (query error)
  // falls through to /rubrics, whose own guard re-routes a genuinely orgless user
  // to onboarding — so a transient count failure never strands someone who still
  // has a team on the onboarding screen.
  const { count } = await supabaseAdmin
    .from("memberships")
    .select("org_id", { count: "exact", head: true })
    .eq("user_id", userId);

  // Every org-scoped server component re-reads the active org, so revalidate the
  // whole tree under the root layout before redirecting.
  revalidatePath("/", "layout");

  redirect(count === 0 ? "/onboarding" : "/rubrics");
}
