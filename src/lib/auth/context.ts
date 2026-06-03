import "server-only";
import { createClient } from "@/lib/supabase/server";

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
 * Sources `userId` from the Supabase Auth session. Orgs and roles arrive in the
 * orgs slice (#47) via `memberships`; until then a signed-in user has no team,
 * so `orgId` is null and writes are blocked.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return {
    userId: user?.id ?? null,
    orgId: null,
    role: "member",
    canWrite: false,
  };
}
