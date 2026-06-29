import "server-only";
import { getAuthContext, type AuthContext } from "@/lib/auth/context";

/**
 * The shared write-gate for `{ error: string }`-returning server actions.
 *
 * Resolves identity through {@link getAuthContext} (React-cached, so it collapses
 * with the request's other reads) and enforces the two checks every contributor
 * action shares: a signed-in user with an active org, and Contributor (`canWrite`)
 * role. On failure it hands back a ready-to-return `{ error }`; on success it
 * returns the resolved `ctx` (for `tenantDb(ctx)`) plus the now-narrowed
 * `userId`/`orgId`.
 *
 * `action` is the verb phrase for the gate message — `requireContributor("create
 * connections")` yields `"Only contributors can create connections"`. The
 * signed-in failure defaults to `"Not authenticated"`; billing actions pass
 * `"Not signed in"` to keep their existing copy.
 *
 * Actions that throw, redirect, or return a different shape (`{ message }`, `{}`,
 * silent `void`) keep their inline checks — this owns only the `{ error: string }`
 * contract.
 */
export async function requireContributor(
  action: string,
  signedInError = "Not authenticated",
): Promise<
  { error: string } | { ctx: AuthContext; userId: string; orgId: string }
> {
  const ctx = await getAuthContext();
  if (!ctx.userId || !ctx.orgId) return { error: signedInError };
  if (!ctx.canWrite) return { error: `Only contributors can ${action}` };
  return { ctx, userId: ctx.userId, orgId: ctx.orgId };
}
