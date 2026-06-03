"use server";

import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";

export type CreateOrgState = { error?: string };

const MAX_NAME_LENGTH = 80;

/**
 * Onboarding: create an organization and make the current user its owner.
 *
 * Replaces Clerk's `useOrganizationList().createOrganization` + `setActive`.
 * The owner membership (`role='admin'`) is what `getAuthContext` reads back as
 * the active org, so the insert order is org → membership, both as the trusted,
 * verified user id. New teams land on Rubrics to author their first rubric.
 */
export async function createOrganization(
  _prevState: CreateOrgState,
  formData: FormData
): Promise<CreateOrgState> {
  const { userId, orgId } = await getAuthContext();
  if (!userId) return { error: "You must be signed in to create a team." };

  // Single-owner today: a user who already has a team can't create another.
  if (orgId) redirect("/rubrics");

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

  redirect("/rubrics");
}
