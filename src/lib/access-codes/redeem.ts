import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";

/**
 * Atomic Access Code claim/release (ADR-0017, #426). Backs the launch-phase
 * sign-up gate's second bypass — the Invitation bypass shipped in #425
 * (src/lib/invitations/pending.ts) is unconditional and never touches this
 * module. This one wraps the two SECURITY DEFINER SQL functions
 * (supabase/migrations/20260706000000_access_codes.sql) that make the cap
 * check + redemption-count increment ONE guarded write:
 *
 *   claimAccessCode()          -- claim_access_code(p_code) — call BEFORE
 *                                  supabase.auth.signUp; no user exists yet.
 *   releaseAccessCodeClaim()   -- release_access_code_claim(p_access_code_id)
 *                                  — call ONLY if user creation itself fails
 *                                  (including the anti-enumeration existing-
 *                                  email path). An unconfirmed-but-created
 *                                  account keeps its slot, by design.
 *   recordAccessCodeRedemption() -- a plain insert (no cap to guard, so no
 *                                  RPC needed) once the new user's id is
 *                                  known — ties the redemption to its
 *                                  redeemer for attribution and the later
 *                                  first-Team binding.
 */

export type AccessCodeClaimStatus = "claimed" | "not_found" | "expired" | "exhausted";

export interface AccessCodeClaim {
  claimed: boolean;
  status: AccessCodeClaimStatus;
  accessCodeId: string | null;
  trialDays: number | null;
  stripeCouponId: string | null;
  planSlug: string | null;
}

interface ClaimAccessCodeRow {
  claimed: boolean;
  status: AccessCodeClaimStatus;
  access_code_id: string | null;
  trial_days: number | null;
  stripe_coupon_id: string | null;
  plan_slug: string | null;
}

const FAILED_CLAIM: AccessCodeClaim = {
  claimed: false,
  status: "not_found",
  accessCodeId: null,
  trialDays: null,
  stripeCouponId: null,
  planSlug: null,
};

/**
 * Attempt to atomically claim one redemption slot on `code`. Never throws —
 * an RPC error fails CLOSED (reported as `not_found`, the same refusal an
 * unrecognized code gets) rather than admitting a sign-up the gate would
 * otherwise refuse.
 */
export async function claimAccessCode(code: string): Promise<AccessCodeClaim> {
  const { data, error } = await supabaseAdmin.rpc("claim_access_code", {
    p_code: code,
  });
  if (error) {
    await log.error("access code claim RPC failed", {
      event: "access_code.claim_failed",
      error,
    });
    return FAILED_CLAIM;
  }

  const row = (Array.isArray(data) ? data[0] : data) as ClaimAccessCodeRow | undefined;
  if (!row) return FAILED_CLAIM;

  return {
    claimed: row.claimed,
    status: row.status,
    accessCodeId: row.access_code_id,
    trialDays: row.trial_days,
    stripeCouponId: row.stripe_coupon_id,
    planSlug: row.plan_slug,
  };
}

/**
 * Hand a claimed slot back. Best-effort: logs and swallows any error rather
 * than throwing — a release failure should never turn into a user-facing
 * error on top of the sign-up failure that triggered it (the count would
 * simply run one over-conservative until an operator notices the log, never
 * over-admitting).
 */
export async function releaseAccessCodeClaim(accessCodeId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("release_access_code_claim", {
    p_access_code_id: accessCodeId,
  });
  if (error) {
    await log.error("access code release RPC failed", {
      event: "access_code.release_failed",
      access_code_id: accessCodeId,
      error,
    });
  }
}

/**
 * Record a successful redemption once the new user's id is known. A plain
 * insert, not an RPC — the cap was already enforced atomically by the claim
 * above, so this row is just the attribution record. Best-effort: logs and
 * swallows rather than failing the sign-up the user already completed.
 */
export async function recordAccessCodeRedemption(
  accessCodeId: string,
  userId: string
): Promise<void> {
  const { error } = await supabaseAdmin.from("access_code_redemptions").insert({
    access_code_id: accessCodeId,
    user_id: userId,
  });
  if (error) {
    await log.error("access code redemption record failed", {
      event: "access_code.redemption_record_failed",
      access_code_id: accessCodeId,
      user_id: userId,
      error,
    });
  }
}
