import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";

/**
 * First-Team binding (ADR-0017 slice 3, #427): stamps the redeemer's unbound
 * Access Code redemption with the Team they just created via
 * `createOrganization` (src/app/actions/orgs.ts).
 *
 * A redemption's billing benefit binds to the FIRST Team its redeemer
 * creates and never transfers again — this guarded UPDATE only ever matches
 * a row whose `org_id` is still null, so:
 *   - a user's first `createOrganization` call stamps it (0 or 1 row, since
 *     sign-up only ever accepts one code);
 *   - any later Team the same user creates finds `org_id` already non-null
 *     and matches nothing — a second Team gets nothing, by design, with no
 *     "is this the first Team?" branch anywhere in the caller;
 *   - a user with no redemption at all (never redeemed a code, or signed up
 *     ungated) also matches nothing.
 * Accepting an Invitation into an existing Team never calls this at all
 * (acceptInvitation doesn't create an org), so it transfers nothing either.
 *
 * Best-effort: logs and swallows any error rather than failing Team creation
 * over this bookkeeping write — a failure here just leaves the redemption
 * orphaned (same as ADR-0017's "never created a Team" case), not lost data
 * a retry could fix (the caller has no reason to retry just this step).
 *
 * Returns `true` when this call actually bound a redemption — i.e. the creator
 * came in through an Access Code and this call is what stamped the benefit onto
 * a Team. `createOrganization` uses that to route a code redeemer to the pricing
 * page after onboarding (so they can apply/convert their benefit) instead of
 * straight into the app. Creating an ADDITIONAL Team while one is already bound,
 * an ungated creator, and a bind error all return `false`, keeping the default
 * in-app landing.
 *
 * The signal is "a redemption is currently unbound," not "first Team ever":
 * `access_code_redemptions.org_id` is `ON DELETE SET NULL`, so a redeemer who
 * deletes their only (bound) Team frees the benefit again, and the next Team
 * they create re-binds it and returns `true` — routing them back to pricing.
 * That is the intended benefit model (an unconverted benefit follows the
 * redeemer to their current Team), not a second-Team leak; the guard against
 * re-routing is the benefit being CONSUMED at checkout, not the first bind.
 */
export async function bindFirstTeamAccessCodeRedemption(
  userId: string,
  orgId: string
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("access_code_redemptions")
    .update({ org_id: orgId })
    .eq("user_id", userId)
    .is("org_id", null)
    .select("access_code_id");

  if (error) {
    await log.error("access code first-Team binding failed", {
      event: "access_code.first_team_bind_failed",
      user_id: userId,
      org_id: orgId,
      error,
    });
    return false;
  }

  return (data?.length ?? 0) > 0;
}
