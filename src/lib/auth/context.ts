import "server-only";
import { auth } from "@clerk/nextjs/server";

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
 * Currently delegates to Clerk `auth()`: `userId`/`orgId` pass through and a
 * Contributor (Clerk `org:admin`) gets `canWrite`.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const { userId, orgId, orgRole } = await auth();
  const canWrite = orgRole === "org:admin";
  return {
    userId: userId ?? null,
    orgId: orgId ?? null,
    role: canWrite ? "admin" : "member",
    canWrite,
  };
}
