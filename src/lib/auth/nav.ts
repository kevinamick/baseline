import "server-only";
import { getAuthContext } from "@/lib/auth/context";
import { getWorkspaceName } from "@/lib/auth/workspace";

/**
 * The identity bits the app nav renders: the Workspace name. This is the shape
 * seeded into the client `AuthProvider` (auth-context.tsx) so the client `NavBar`
 * reads it from context instead of awaiting a server fetch of its own on every
 * navigation.
 */
export interface NavAuth {
  workspaceName: string;
}

/**
 * Resolve the nav identity for the request. Pages already call
 * `getAuthContext()` for their own reads, so this reuses it (React `cache()`
 * collapses the pair) and adds only the Workspace name. The layout hands the
 * result to `AuthProvider`.
 */
export async function resolveNavAuth(): Promise<NavAuth> {
  const { orgId } = await getAuthContext();
  return { workspaceName: await getWorkspaceName(orgId) };
}
