import type { SupabaseClient } from "@supabase/supabase-js";
import { LLM_PROVIDERS, MANAGED_KEY_ENV, type LlmProvider } from "./provider-list.js";
import { defaultJudgeModelForProvider } from "./models.js";
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
  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("status")
    .eq("org_id", orgId)
    .maybeSingle();
  if (customerError) throw new Error(`Failed to read billing status: ${customerError.message}`);
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

/**
 * Pick the provider + judge model for an eval run, and resolve its key (#204).
 *
 * Eval runs carry no per-run model (unlike optimization runs, which derive the
 * provider from their reflect model), so the judge provider is discovered from
 * the Team's keys:
 *   - A Team that brought its own key judges on THAT provider's default judge
 *     model, at its own cost — so a Free Team with only an OpenAI key judges on
 *     OpenAI. When several BYO keys exist, the first in `LLM_PROVIDERS` order
 *     wins (Anthropic leads, a deterministic, judge-tuned default).
 *   - No BYO key → Anthropic: a paid Team falls back to the managed Anthropic
 *     key (the platform bears the cost, so managed judging pins to the one
 *     provider we price), and a Free Team fails closed ("none"). The app's
 *     eval-run gate refuses a keyless Free Team before the run is created.
 */
export async function resolveEvalJudge(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ provider: LlmProvider; judgeModel: string; resolved: ResolvedKey }> {
  // A BYO candidate is only honored when it resolves to an ACTUAL byo key. A row
  // with an empty/whitespace secret falls through resolveProviderKey to that
  // provider's managed env var for a paid Team — which would judge a non-Anthropic
  // provider on a managed key, breaking the invariant that managed judging pins to
  // Anthropic (the one provider we price). In that case fall back to Anthropic.
  const candidate = await firstByoProvider(supabase, orgId);
  if (candidate) {
    const resolved = await resolveProviderKey(supabase, orgId, candidate);
    if (resolved.source === "byo") {
      return {
        provider: candidate,
        judgeModel: defaultJudgeModelForProvider(candidate),
        resolved,
      };
    }
  }

  const provider: LlmProvider = "anthropic";
  const judgeModel = defaultJudgeModelForProvider(provider);
  const resolved = await resolveProviderKey(supabase, orgId, provider);
  return { provider, judgeModel, resolved };
}

/** The provider the Team has a BYO key for, first in LLM_PROVIDERS order, or null. */
async function firstByoProvider(
  supabase: SupabaseClient,
  orgId: string
): Promise<LlmProvider | null> {
  const { data, error } = await supabase
    .from("provider_keys")
    .select("provider")
    .eq("org_id", orgId)
    .in("provider", LLM_PROVIDERS as unknown as string[]);
  if (error) throw new Error(`Failed to read provider keys: ${error.message}`);
  const have = new Set((data ?? []).map((r: { provider: string }) => r.provider));
  return LLM_PROVIDERS.find((p) => have.has(p)) ?? null;
}

/** The user-facing failure when a Team has no usable key for a run. */
export const MISSING_PROVIDER_KEY_MESSAGE =
  "Your team has no LLM provider key. Add one under Settings → Team to run — " +
  "the Free plan requires your own provider key.";
