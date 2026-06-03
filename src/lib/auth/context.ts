import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Coarse role derived from the auth provider. The org owner / Contributor is
 * `admin` (write access); everyone else is a read-only `member`.
 */
export type Role = "admin" | "member";

export interface AuthContext {
  userId: string | null;
  orgId: string | null;
  role: Role;
  /** Contributors may create/edit/delete; read-only members may not. */
  canWrite: boolean;
}

/**
 * The single server-side seam over the auth provider. Every server read of
 * identity and role flows through here so the provider stays isolated to this
 * module — later slices swap the body without touching call sites.
 *
 * Sources `userId` from the Supabase Auth session, then resolves the active org
 * and role from `memberships`. The model is single-owner today: a user has at
 * most one membership, and the owner is `admin` (writes); read-only `member`s
 * arrive with invitations (#50). A signed-in user with no membership has no team
 * (`orgId` null) and is sent to onboarding by the protected pages.
 *
 * Identity comes from the cookie-bound client (`getUser()` revalidates the JWT);
 * the membership read uses the service-role client, mirroring every other
 * server-side data read, and is trusted because it is keyed by that verified id.
 *
 * Wrapped in React `cache()` so repeated calls within one request collapse to a
 * single round-trip.
 */
export const getAuthContext = cache(async (): Promise<AuthContext> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { userId: null, orgId: null, role: "member", canWrite: false };
  }

  const { data: membership } = await supabaseAdmin
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  const role: Role = membership?.role === "admin" ? "admin" : "member";

  return {
    userId: user.id,
    orgId: membership?.org_id ?? null,
    role,
    canWrite: role === "admin",
  };
});
