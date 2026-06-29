"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setActiveOrgCookie } from "@/lib/auth/active-org";

/**
 * Switch the signed-in user's active organization (#52). Replaces Clerk's
 * `setActive`. The active org is persisted in the `active_org` cookie, which
 * `getAuthContext` reads back.
 *
 * The cookie is a selection hint, not a grant, so we still verify the user is a
 * member of the target org before writing it — a forged submit for an org they
 * don't belong to is silently ignored (the read-time validation in
 * getAuthContext would reject it anyway; this is defense in depth at write time).
 */
export async function switchOrg(formData: FormData): Promise<void> {
  const orgId = formData.get("orgId");
  const { userId } = await getAuthContext();
  if (!userId || typeof orgId !== "string" || !orgId) return;

  const { data: membership } = await supabaseAdmin
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!membership) return;

  await setActiveOrgCookie(orgId);

  // Every org-scoped server component re-reads the active org from context, so
  // revalidate the whole tree under the root layout.
  revalidatePath("/", "layout");
}
