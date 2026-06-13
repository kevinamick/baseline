import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGED_KEY_ENV, type LlmProvider } from "./provider-list.js";
import { log } from "../log.js";

// Per-Team BYO key resolution at run time (#184). Precedence:
//   1. The Team has a BYO key for the provider → use it (any plan).
//   2. No BYO key + the Team is on an active PAID subscription → fall back to the
//      managed platform key (current behavior; managed metering is S8).
//   3. No BYO key + Free (or a lapsed/unpaid sub) → "none": the run fails closed.
//      Free Teams run on BYO only — no managed fallback, no card on file (ADR-0008).
//
// Mirror of the app's ACTIVE_STATUSES (src/lib/billing/state.ts): the Stripe
// subscription statuses that grant paid access. A Free Team has no customers
// mirror row at all, so it collapses to "none" — exactly the fail-closed default.
const ACTIVE_PAID_STATUSES = ["active", "trialing"];

export type ResolvedKey =
  | { source: "byo"; key: string }
  | { source: "managed"; key: string }
  | { source: "none" };

export async function resolveProviderKey(
  supabase: SupabaseClient,
  orgId: string,
  provider: LlmProvider
): Promise<ResolvedKey> {
  // 1) The Team's own key wins, on any plan.
  const { data: row, error } = await supabase
    .from("provider_keys")
    .select("secret_id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`Failed to read provider key: ${error.message}`);

  if (row?.secret_id) {
    const { data: secret, error: secErr } = await supabase.rpc("get_provider_secret", {
      p_secret_id: row.secret_id,
    });
    if (secErr) throw new Error(`Failed to read provider key: ${secErr.message}`);
    const key = (secret as string | null)?.trim();
    if (key) return { source: "byo", key };
  }

  // 2) No BYO key — a paid Team falls back to the managed platform key.
  const { data: customer } = await supabase
    .from("customers")
    .select("status")
    .eq("org_id", orgId)
    .maybeSingle();
  const paid =
    customer?.status != null && ACTIVE_PAID_STATUSES.includes(customer.status);

  if (paid) {
    const managed = process.env[MANAGED_KEY_ENV[provider]]?.trim();
    if (managed) return { source: "managed", key: managed };
    // Paid, but no managed key is configured for this provider in the worker
    // env. Fail closed rather than reach for some other provider's key.
    log.warn("Managed key not configured for provider", {
      event: "provider_key.managed_missing",
      provider,
    });
    return { source: "none" };
  }

  // 3) Free Team with no BYO key — the Free invariant: fail closed.
  return { source: "none" };
}

/** The user-facing failure when a Team has no usable key for a run. */
export const MISSING_PROVIDER_KEY_MESSAGE =
  "Your team has no LLM provider key. Add one under Settings → API Keys to run — " +
  "the Free plan requires your own provider key.";
