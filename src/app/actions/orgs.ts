"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/active-org";
import { track } from "@/lib/analytics/server";

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
    console.error("organization insert failed", orgError);
    return { error: "Could not create your team. Please try again." };
  }

  const { error: membershipError } = await supabaseAdmin
    .from("memberships")
    .insert({ org_id: org.id, user_id: userId, role: "admin" });

  if (membershipError) {
    console.error("membership insert failed", membershipError);
    // Roll back the orphaned org so a retry starts clean. If the cleanup itself
    // fails, surface it — the org is left orphaned and needs manual attention.
    const { error: rollbackError } = await supabaseAdmin
      .from("organizations")
      .delete()
      .eq("id", org.id);
    if (rollbackError) {
      console.error("org rollback failed; orphaned org", org.id, rollbackError);
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

  redirect("/rubrics");
}
