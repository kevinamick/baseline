import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RUNTIME_READY_PROVIDERS,
  PROVIDER_KEY_ENV,
  defaultJudgeModelForProvider,
  type LlmProvider,
} from "./registry.js";

// Provider-key resolution at run time (ADR-0020). Precedence, identical to the app's
// `resolveKeySource` (src/lib/llm/key-gate.ts):
//   1. A USABLE key saved under Settings → Provider keys (Vault) → "byo".
//   2. Else the operator's env var for the provider (PROVIDER_KEY_ENV) → "env".
//   3. Else "none": the run fails closed naming the missing key.
// Both sources are the operator's own key; nothing is metered on either.

export type ResolvedKey =
  | { source: "byo"; key: string }
  | { source: "env"; key: string }
  | { source: "none" };

/** The operator's env key for a provider, or null when unset/blank. */
export function envProviderKey(provider: LlmProvider): string | null {
  return process.env[PROVIDER_KEY_ENV[provider]]?.trim() || null;
}

/**
 * Read a provider's stored key row and, if present, its Vault secret — returning the trimmed
 * secret only when it is non-empty (a USABLE key), or null otherwise (no row at all, or a row
 * whose secret is empty/whitespace). The one definition of "does this Workspace have a usable
 * saved key for this provider," shared by `resolveProviderKey` (single fixed provider) and the
 * eval judge's multi-provider discovery so the two can't drift on what counts as usable (#371).
 * Fails closed on a read error (throws) rather than silently treating the row as absent.
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
  const key = await readUsableByoKey(supabase, orgId, provider);
  if (key) return { source: "byo", key };
  const env = envProviderKey(provider);
  if (env) return { source: "env", key: env };
  return { source: "none" };
}

/**
 * Pick the provider + judge model for an eval run, and resolve its key (#204, #371).
 *
 * Eval runs carry no per-run model (unlike optimization runs, which derive the provider from
 * their reflect model), so the judge provider is discovered from the Workspace's keys: the first
 * `RUNTIME_READY_PROVIDERS`-order provider with a USABLE saved key wins (Anthropic leads, a
 * deterministic, judge-tuned default); a provider whose row has a blank secret is skipped, never
 * chosen. With no saved key anywhere, the first provider with an env key wins the same way. With
 * neither, "none" — the app's eval-run gate refuses a keyless Workspace before the run exists.
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
  for (const provider of RUNTIME_READY_PROVIDERS) {
    const key = envProviderKey(provider);
    if (key) {
      return {
        provider,
        judgeModel: defaultJudgeModelForProvider(provider),
        resolved: { source: "env", key },
      };
    }
  }
  const provider: LlmProvider = "anthropic";
  return { provider, judgeModel: defaultJudgeModelForProvider(provider), resolved: { source: "none" } };
}

/**
 * The first `RUNTIME_READY_PROVIDERS`-order provider with a USABLE saved key (a non-empty-after-
 * trim secret), or null if none (#371). One batched row read up front, then a secret-usability
 * RPC only for providers that have a row, walked in provider order and stopped at the first
 * usable one — so a later provider's usable key is never masked by an earlier provider's row
 * that merely exists but is blank.
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
    // A transient secret-read failure for THIS candidate is treated as unusable (not thrown)
    // so it can't mask a usable later-provider key.
    const { data: secret, error: secErr } = await supabase.rpc("get_provider_secret", {
      p_secret_id: secretId,
    });
    if (secErr) continue;
    const key = (secret as string | null)?.trim();
    if (key) return { provider, key };
  }
  return null;
}

/** The user-facing failure when the Workspace has no usable key for a run. */
export const MISSING_PROVIDER_KEY_MESSAGE =
  "No provider key is available for this run. Save one under Settings → Provider keys, " +
  "or set the provider's API key (for example ANTHROPIC_API_KEY) in the worker environment.";
