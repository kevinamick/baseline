import "server-only";
import { getAuthContext } from "@/lib/auth/context";
import { getWorkspaceName } from "@/lib/auth/workspace";
import { getBillingState } from "@/lib/billing/state";
import type { PlanSlug } from "@/lib/billing/plans";

/**
 * The identity bits the app nav renders: the Workspace name and the effective
 * plan. This is the shape seeded into the client `AuthProvider`
 * (auth-context.tsx) so the client `NavBar` reads it from context instead of
 * awaiting a server fetch of its own on every navigation.
 */
export interface NavAuth {
  workspaceName: string;
  /** The effective plan slug — drives the nav Upgrade CTA on the free plan (#349). */
  plan: PlanSlug;
}

/**
 * Resolve the nav identity for the request. Pages already call
 * `getAuthContext()` for their own reads, so this reuses it (React `cache()`
 * collapses the pair) and adds only the Workspace name. The layout hands the
 * result to `AuthProvider`.
 */
export async function resolveNavAuth(): Promise<NavAuth> {
  const { orgId } = await getAuthContext();
  const [workspaceName, billing] = await Promise.all([
    getWorkspaceName(orgId),
    getBillingState(orgId),
  ]);
  return { workspaceName, plan: billing.plan };
}
