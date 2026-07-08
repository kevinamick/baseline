import "server-only";
import { getAuthContext, type AuthContext } from "@/lib/auth/context";
import { localizeError } from "@/lib/i18n/errors";

/**
 * The verb-phrase keys `Errors.common.contributorRequired*` carries a full
 * sentence per action (no `{action}` interpolation) — mirrors the Run Gate's
 * seat-cap copy (`src/lib/billing/run-gate.ts`) so es/fr grammar stays
 * natural instead of concatenating a translated noun phrase into a template.
 */
const CONTRIBUTOR_ACTION_KEY = {
  manageProviderKeys: "contributorRequiredManageProviderKeys",
  createConnections: "contributorRequiredCreateConnections",
  editConnections: "contributorRequiredEditConnections",
  deleteConnections: "contributorRequiredDeleteConnections",
  startOptimizationRuns: "contributorRequiredStartOptimizationRuns",
  cancelOptimizationRuns: "contributorRequiredCancelOptimizationRuns",
  retryOptimizationRuns: "contributorRequiredRetryOptimizationRuns",
  changeBillingSettings: "contributorRequiredChangeBillingSettings",
  changeThePlan: "contributorRequiredChangeThePlan",
  createSchedules: "contributorRequiredCreateSchedules",
  runEvaluations: "contributorRequiredRunEvaluations",
} as const;
export type ContributorAction = keyof typeof CONTRIBUTOR_ACTION_KEY;

/**
 * The shared write-gate for `{ error: string }`-returning server actions.
 *
 * Resolves identity through {@link getAuthContext} (React-cached, so it collapses
 * with the request's other reads) and enforces the two checks every contributor
 * action shares: a signed-in user with an active org, and Contributor (`canWrite`)
 * role. On failure it hands back a ready-to-return `{ error }`, rendered in the
 * caller's locale (`localizeError`, #407); on success it returns the resolved
 * `ctx` (for `tenantDb(ctx)`) plus the now-narrowed `userId`/`orgId`.
 *
 * `action` is one of `CONTRIBUTOR_ACTION_KEY`'s keys — `requireContributor
 * ("createConnections")` yields `"Only contributors can create connections"`.
 * The signed-in failure defaults to `Errors.common.notAuthenticated`; billing
 * actions pass `"notSignedIn"` to keep their existing copy.
 *
 * Actions that throw, redirect, or return a different shape (`{ message }`, `{}`,
 * silent `void`) keep their inline checks — this owns only the `{ error: string }`
 * contract.
 */
export async function requireContributor(
  action: ContributorAction,
  signedInErrorKey: "notAuthenticated" | "notSignedIn" = "notAuthenticated",
): Promise<
  { error: string } | { ctx: AuthContext; userId: string; orgId: string }
> {
  const ctx = await getAuthContext();
  if (!ctx.userId || !ctx.orgId) {
    return { error: await localizeError("common", signedInErrorKey) };
  }
  if (!ctx.canWrite) {
    return { error: await localizeError("common", CONTRIBUTOR_ACTION_KEY[action]) };
  }
  return { ctx, userId: ctx.userId, orgId: ctx.orgId };
}
