import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RUNTIME_READY_PROVIDERS,
  MANAGED_KEY_ENV,
  defaultJudgeModelForProvider,
  type LlmProvider,
} from "./registry.js";
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

/**
 * Read a provider's stored key row and, if present, its Vault secret — returning the trimmed
 * secret only when it is non-empty (a USABLE BYO key), or null otherwise (no row at all, or a
 * row whose secret is empty/whitespace). The one definition of "does this Team have a usable BYO
 * key for this provider," shared by `resolveProviderKey` (single fixed provider) and the eval
 * judge's multi-provider discovery (`firstUsableByoProvider`) so the two can't drift on what
 * counts as usable (#371). Fails closed on a read error (throws) rather than silently treating
 * the row as absent.
 */
async function readUsableByoKey(
  supabase: SupabaseClient,
  orgId: string,
  provider: LlmProvider
): Promise<string | null> {
  const { data: row, error } = await supabase
    .from("provider_keys")
    .select("secret_id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`Failed to read provider key: ${error.message}`);
  if (!row?.secret_id) return null;

  const { data: secret, error: secErr } = await supabase.rpc("get_provider_secret", {
    p_secret_id: row.secret_id,
  });
  if (secErr) throw new Error(`Failed to read provider key: ${secErr.message}`);
  return (secret as string | null)?.trim() || null;
}

export async function resolveProviderKey(
  supabase: SupabaseClient,
  orgId: string,
  provider: LlmProvider
): Promise<ResolvedKey> {
  // 1) The Team's own key wins, on any plan.
  const key = await readUsableByoKey(supabase, orgId, provider);
  if (key) return { source: "byo", key };

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
 * Pick the provider + judge model for an eval run, and resolve its key (#204, #371).
 *
 * Eval runs carry no per-run model (unlike optimization runs, which derive the
 * provider from their reflect model), so the judge provider is discovered from
 * the Team's keys:
 *   - A Team that brought its own USABLE key judges on THAT provider's default
 *     judge model, at its own cost — so a Free Team with only an OpenAI key
 *     judges on OpenAI. When several BYO keys exist, the first in
 *     `RUNTIME_READY_PROVIDERS` order wins (Anthropic leads, a deterministic,
 *     judge-tuned default). A provider whose row has an empty/whitespace
 *     secret is skipped — it falls through to the next runtime-ready
 *     provider with a usable key, never straight to managed (#371: this used
 *     to stop at the first provider with ANY row, so a blank Anthropic
 *     secret sitting alongside a usable OpenAI key wrongly fell all the way
 *     to managed Anthropic instead of judging BYO on OpenAI).
 *   - No usable BYO key for any runtime-ready provider → Anthropic: a paid
 *     Team falls back to the managed Anthropic key (the platform bears the
 *     cost, so managed judging pins to the one provider we price), and a
 *     Free Team fails closed ("none"). The app's eval-run gate refuses a
 *     keyless Free Team before the run is created.
 */
export async function resolveEvalJudge(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ provider: LlmProvider; judgeModel: string; resolved: ResolvedKey }> {
  const candidate = await firstUsableByoProvider(supabase, orgId);
  if (candidate) {
    return {
      provider: candidate.provider,
      judgeModel: defaultJudgeModelForProvider(candidate.provider),
      resolved: { source: "byo", key: candidate.key },
    };
  }

  const provider: LlmProvider = "anthropic";
  const judgeModel = defaultJudgeModelForProvider(provider);
  const resolved = await resolveProviderKey(supabase, orgId, provider);
  return { provider, judgeModel, resolved };
}

/**
 * The first `RUNTIME_READY_PROVIDERS`-order provider with a USABLE BYO key (a
 * non-empty-after-trim secret), or null if none (#371). One batched row read
 * (which providers even have a stored key) up front, then a secret-usability
 * RPC only for providers that do, walked in provider order and stopped at the
 * first usable one — so a later provider's usable key is never masked by an
 * earlier provider's row that merely exists but is blank. Scans
 * `RUNTIME_READY_PROVIDERS` (not the full `LLM_PROVIDERS` list) so a
 * storage-only "coming soon" provider can never be picked as the judge,
 * matching the app's `hasRuntimeProviderKey` (`src/lib/llm/key-gate.ts`).
 */
async function firstUsableByoProvider(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ provider: LlmProvider; key: string } | null> {
  const { data, error } = await supabase
    .from("provider_keys")
    .select("provider, secret_id")
    .eq("org_id", orgId)
    .in("provider", RUNTIME_READY_PROVIDERS as unknown as string[]);
  if (error) throw new Error(`Failed to read provider keys: ${error.message}`);

  const secretIdByProvider = new Map(
    ((data ?? []) as { provider: string; secret_id: string | null }[]).map((row) => [
      row.provider,
      row.secret_id,
    ])
  );

  for (const provider of RUNTIME_READY_PROVIDERS) {
    const secretId = secretIdByProvider.get(provider);
    if (!secretId) continue;
    // A transient secret-read failure for THIS candidate is treated as
    // unusable (not thrown) so it can't mask a usable later-provider key —
    // mirrors the app's isSecretUsable fail-closed-but-keep-scanning
    // convention. The final Anthropic fallback below still uses
    // resolveProviderKey, which DOES throw on a read failure (no further
    // provider to fall through to).
    const { data: secret, error: secErr } = await supabase.rpc("get_provider_secret", {
      p_secret_id: secretId,
    });
    if (secErr) continue;
    const key = (secret as string | null)?.trim();
    if (key) return { provider, key };
  }
  return null;
}

/** The user-facing failure when a Team has no usable key for a run. */
export const MISSING_PROVIDER_KEY_MESSAGE =
  "Your team has no LLM provider key. Add one under Settings → Team to run — " +
  "the Free plan requires your own provider key.";
