import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Role } from "@/lib/auth/context";

export interface OrgMember {
  userId: string;
  /** Sourced from `auth.users`; null only if the auth lookup can't resolve it. */
  email: string | null;
  role: Role;
}

export interface UserOrg {
  orgId: string;
  name: string;
}

/**
 * List the organizations a user belongs to (id + display name), oldest first.
 * Powers the nav-bar org switcher (#52). The display name lives on
 * `organizations`, so this joins it onto the user's membership rows.
 */
export async function listUserOrgs(userId: string): Promise<UserOrg[]> {
  const { data: rows } = await supabaseAdmin
    .from("memberships")
    .select("org_id, created_at, organizations(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    // Stable tie-breaker so the switcher order (and getAuthContext's fallback,
    // which keys off the same ordering) doesn't flip on equal created_at.
    .order("org_id", { ascending: true });

  return (rows ?? []).map((row) => {
    // The embedded relation comes back as an object (or array, depending on the
    // inferred cardinality); normalize to the single related org's name.
    const org = row.organizations as { name: string } | { name: string }[] | null;
    const name = Array.isArray(org) ? org[0]?.name : org?.name;
    return { orgId: row.org_id, name: name ?? "Untitled team" };
  });
}

/**
 * List an org's members with their email + role, oldest first. Membership lives
 * in `public.memberships`, but the email lives in `auth.users` (not exposed to
 * the data client), so we resolve each via the admin auth API. Teams are small
 * (single-owner today; members arrive by invitation), so per-member lookups are
 * fine here.
 */
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const { data: rows } = await supabaseAdmin
    .from("memberships")
    .select("user_id, role, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  return Promise.all(
    (rows ?? []).map(async (m) => {
      // A transport failure rejects rather than returning `{ error }`; one bad
      // lookup shouldn't take down the whole team page, so fall back to null.
      const { data } = await supabaseAdmin.auth.admin
        .getUserById(m.user_id)
        .catch(() => ({ data: { user: null } }));
      return {
        userId: m.user_id,
        email: data.user?.email ?? null,
        role: m.role === "admin" ? "admin" : "member",
      };
    })
  );
}
