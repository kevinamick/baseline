import "server-only";
// provider_keys reads here stay on the raw admin client (not tenantDb): these are
// orgId-param lib functions, not ctx-holding actions, and tenantDb is ctx-only by
// design (#207). Each read is already org-scoped by an explicit `.eq("org_id", orgId)`.
// See the TENANT SCOPING note in ./keys.ts.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { RUNTIME_READY_PROVIDERS, type LlmProvider } from "@/lib/llm/providers";
import { PROVIDER_KEY_ENV } from "../../../worker/src/providers/registry";
import { readUsableProviderSecret } from "@/lib/llm/provider-secret";

/**
 * Where a provider's key comes from (ADR-0020). Single source: the type is derived
 * from this const, and every comparison uses a member (KEY_SOURCE.vault) rather than
 * a bare string literal. Precedence, identical to the worker's run-time
 * `resolveProviderKey` (`worker/src/providers/resolve-key.ts`):
 *   - a USABLE key pasted into Settings (Vault) → "vault"
 *   - else the operator's `<PROVIDER>_API_KEY` env var → "env"
 *   - else "none": a run on this provider fails closed naming the missing key.
 * Nothing is metered on either source — both are the operator's own key.
 */
export const KEY_SOURCE = {
  vault: "vault",
  env: "env",
  none: "none",
} as const;
export type KeySource = (typeof KEY_SOURCE)[keyof typeof KEY_SOURCE];

/** The operator's env key for a provider, or null when unset/blank. */
export function envProviderKey(provider: LlmProvider): string | null {
  return process.env[PROVIDER_KEY_ENV[provider]]?.trim() || null;
}

/**
 * Whether a provider's Vault secret is a USABLE key (non-empty after trim). The one
 * definition of "usable secret", mirroring the worker's `readUsableByoKey` so the app's
 * pre-run check and the worker's run-time resolution can't drift (#371). Fails closed
 * on an unreadable secret — treated as unusable, never waved through.
 */
async function isSecretUsable(secretId: string | null): Promise<boolean> {
  if (!secretId) return false;
  const { data: secret, error } = await supabaseAdmin.rpc("get_provider_secret", {
    p_secret_id: secretId,
  });
  if (error) return false;
  return !!(secret as string | null)?.trim();
}

/** Resolve one provider's key source (Vault → env → none). */
export async function resolveKeySource(
  orgId: string,
  provider: LlmProvider,
): Promise<KeySource> {
  if (await readUsableProviderSecret(orgId, provider)) return KEY_SOURCE.vault;
  return envProviderKey(provider) ? KEY_SOURCE.env : KEY_SOURCE.none;
}

/**
 * Batched form of resolveKeySource for a whole set of providers: one `.in()`
 * provider_keys read, then a secret-usability check only for the providers that have
 * a row, then the env fallback in memory. Fails closed the same way: an unreadable key
 * table throws rather than silently waving providers in.
 */
export async function resolveKeySources(
  orgId: string,
  providers: readonly LlmProvider[],
): Promise<Map<LlmProvider, KeySource>> {
  const keys = await supabaseAdmin
    .from("provider_keys")
    .select("provider, secret_id")
    .eq("org_id", orgId)
    .in("provider", providers as unknown as string[]);
  if (keys.error) throw keys.error;
  const secretIdByProvider = new Map(
    ((keys.data ?? []) as { provider: string; secret_id: string | null }[]).map((r) => [
      r.provider,
      r.secret_id,
    ]),
  );
  const sources = new Map<LlmProvider, KeySource>();
  for (const provider of providers) {
    const usable = await isSecretUsable(secretIdByProvider.get(provider) ?? null);
    sources.set(
      provider,
      usable ? KEY_SOURCE.vault : envProviderKey(provider) ? KEY_SOURCE.env : KEY_SOURCE.none,
    );
  }
  return sources;
}

/**
 * Whether ANY runtime-ready provider has a usable key (Vault or env). The eval judge is
 * provider-aware (`resolveEvalJudge` in the worker judges on whichever runtime-ready
 * provider has a key, Anthropic first), so a Workspace with only an OpenAI key still
 * runs. Fails closed: an unreadable key table counts as no key.
 */
export async function hasRuntimeProviderKey(orgId: string): Promise<boolean> {
  const sources = await resolveKeySources(orgId, RUNTIME_READY_PROVIDERS);
  for (const source of sources.values()) {
    if (source !== KEY_SOURCE.none) return true;
  }
  return false;
}

/** The number of runtime-ready providers with a usable key — drives the onboarding key step. */
export async function countUsableProviders(orgId: string): Promise<number> {
  const sources = await resolveKeySources(orgId, RUNTIME_READY_PROVIDERS);
  let n = 0;
  for (const source of sources.values()) if (source !== KEY_SOURCE.none) n += 1;
  return n;
}

/**
 * Whether an eval run must be refused for want of a provider key (#184, ADR-0020):
 * there is no managed fallback, so a Workspace with no usable key for any
 * runtime-ready provider fails closed before a run row exists.
 */
export async function evalRunBlockedForMissingKey(orgId: string): Promise<boolean> {
  return !(await hasRuntimeProviderKey(orgId));
}

/** The one user-facing wording for a missing-key refusal, varied by provider when known. */
export function missingKeyError(provider?: LlmProvider): string {
  const which = provider ? `a ${PROVIDER_KEY_ENV[provider]} env var or ` : "";
  return `No provider key is available. Set ${which}an LLM provider key under Settings → Provider keys, then try again.`;
}
