import "server-only";
import { getAuthContext } from "@/lib/auth/context";
import { listUserOrgs, type UserOrg } from "@/lib/auth/members";
import { getBillingState } from "@/lib/billing/state";
import type { PlanSlug } from "@/lib/billing/plans";

/**
 * The identity bits the app nav renders: the active org, the orgs the user can
 * switch between (#52), their email, and whether they may manage the team. This
 * is the shape seeded into the client `AuthProvider` (auth-context.tsx) so the
 * now-client `NavBar` reads it from context instead of awaiting a server fetch
 * of its own on every navigation.
 */
export interface NavAuth {
  orgs: UserOrg[];
  activeOrgId: string | null;
  email: string | null;
  canManageTeam: boolean;
  /** The effective plan slug — drives the nav Upgrade CTA on the free plan (#349). */
  plan: PlanSlug;
}

/**
 * Resolve the nav identity for the signed-in request. Auth-gated pages already
 * call `getAuthContext()` for their own gating, so this reuses it (React
 * `cache()` collapses the pair to a single round-trip) and adds only the org
 * list the switcher needs. The page hands the result to `AuthProvider`.
 */
export async function resolveNavAuth(): Promise<NavAuth> {
  const { userId, email, orgId, canWrite } = await getAuthContext();
  const [orgs, billing] = await Promise.all([
    userId ? listUserOrgs(userId) : Promise.resolve([] as UserOrg[]),
    getBillingState(orgId),
  ]);
  return { orgs, activeOrgId: orgId, email, canManageTeam: canWrite, plan: billing.plan };
}
