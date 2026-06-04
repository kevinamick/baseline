import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/active-org";

/**
 * Coarse role derived from the auth provider. The org owner / Contributor is
 * `admin` (write access); everyone else is a read-only `member`.
 */
export type Role = "admin" | "member";

export interface AuthContext {
  userId: string | null;
  /** The signed-in user's email, for identity display (e.g. the nav account menu). */
  email: string | null;
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
 * and role from `memberships`. A user may belong to several orgs (#52); the
 * active one is chosen by the `active_org` cookie, *validated* against their
 * memberships, falling back to the oldest membership. The owner is `admin`
 * (writes); read-only `member`s arrive with invitations (#50). A signed-in user
 * with no membership has no team (`orgId` null) and is sent to onboarding by the
 * protected pages.
 *
 * The cookie is only ever a hint: role and orgId come from the membership row, so
 * a forged cookie naming an org the user isn't in resolves to no match and the
 * fallback applies — never to access they don't have. This is the one place that
 * reads the cookie; everything else flows through this context.
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
    return {
      userId: null,
      email: null,
      orgId: null,
      role: "member",
      canWrite: false,
    };
  }

  // A user may belong to several orgs; read them all (oldest first so the
  // fallback is deterministic), then pick the active one named by the cookie.
  const { data: memberships } = await supabaseAdmin
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const list = memberships ?? [];
  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  // Honor the cookie only when it names an org the user actually belongs to;
  // otherwise default to the oldest membership (or no team at all).
  const membership =
    list.find((m) => m.org_id === activeOrgId) ?? list[0] ?? null;

  const role: Role = membership?.role === "admin" ? "admin" : "member";

  return {
    userId: user.id,
    email: user.email ?? null,
    orgId: membership?.org_id ?? null,
    role,
    canWrite: role === "admin",
  };
});
