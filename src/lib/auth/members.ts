import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Role } from "@/lib/auth/context";

export interface OrgMember {
  userId: string;
  /** Sourced from `auth.users`; null only if the auth lookup can't resolve it. */
  email: string | null;
  role: Role;
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
