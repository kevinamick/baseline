import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Whether a user is a Contributor (admin membership) of a specific Team. Keyed by
 * the verified user id *and* the target org, so a forged or guessed org id the
 * user has no membership in resolves to false — the server-side backstop for
 * Team-scoped actions like billing checkout (#178) that accept an org id from the
 * caller. A read-only `member` is not a Contributor and returns false.
 */
export async function isTeamAdmin(
  orgId: string,
  userId: string
): Promise<boolean> {
  if (!orgId || !userId) return false;
  const { data, error } = await supabaseAdmin
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.role === "admin";
}
