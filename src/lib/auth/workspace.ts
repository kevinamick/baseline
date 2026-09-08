import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { LOCAL_WORKSPACE_NAME } from "@/lib/auth/local-workspace";

/**
 * The Workspace's display name (the `organizations` row's `name`). Falls back to
 * the fixed default so a heading never renders empty — the seed migration
 * inserts the row, but a read error must not blank the nav.
 */
export async function getWorkspaceName(
  orgId: string,
  fallback: string = LOCAL_WORKSPACE_NAME,
): Promise<string> {
  const { data } = await supabaseAdmin
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();
  return data?.name ?? fallback;
}
