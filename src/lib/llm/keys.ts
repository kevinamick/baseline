import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  isLlmProvider,
  isRuntimeReady,
  type LlmProvider,
} from "@/lib/llm/providers";
import { validateProviderKeyFormat as validateProviderKey } from "../../../worker/src/providers/registry";
import { localizeError } from "@/lib/i18n/errors";

/**
 * Per-Team BYO provider keys in Supabase Vault (#184). The provider_keys row
 * holds only a Vault secret reference and a masked last4 — the plaintext key
 * never lives in a public table, is never returned by any API, and is read back
 * only by the worker (service role) at run time. Mirrors the Connections secret
 * helpers (src/lib/connections/create.ts).
 *
 * TENANT SCOPING: these helpers deliberately stay on the raw admin client rather
 * than the `tenantDb(ctx)` org-scoping helper (#207). They take a trusted
 * `orgId: string` param (resolved by the caller — onboarding step, settings
 * action, run-estimate path), not an `AuthContext`, and `tenantDb` is ctx-only by
 * design. Every read/delete here is already org-scoped by an explicit
 * `.eq("org_id", orgId)`, and `set_provider_key` scopes in SQL — so the helper
 * would add nothing a forgotten filter could. Same call shape as the billing
 * `orgId`-param libs, which stay direct for the same reason.
 */

export interface ProviderKeySummary {
  provider: LlmProvider;
  /** Last 4 chars of the stored key, for masked display. Null on legacy rows. */
  last4: string | null;
  updatedAt: string;
}

/** Masked summaries for the settings page — never the key, only its tail. */
export async function listProviderKeys(orgId: string): Promise<ProviderKeySummary[]> {
  const { data, error } = await supabaseAdmin
    .from("provider_keys")
    .select("provider, last4, updated_at")
    .eq("org_id", orgId);
  if (error) throw error;

  return (data ?? [])
    .filter((r) => isLlmProvider(r.provider))
    .map((r) => ({
      provider: r.provider as LlmProvider,
      last4: (r.last4 as string | null) ?? null,
      updatedAt: r.updated_at as string,
    }));
}

/**
 * One row per provider in LLM_PROVIDERS, merged with the Team's stored keys —
 * the view model the ProviderKeysList renders. Shared by the Team settings
 * section and the onboarding key step. The key value never appears here.
 */
export interface ProviderKeyRow {
  provider: LlmProvider;
  label: string;
  /** Has a runtime SDK client wired today; others store keys but show "Coming soon". */
  runtimeReady: boolean;
  last4: string | null;
  hasKey: boolean;
  updatedAt: string | null;
}

export async function getProviderKeyRows(orgId: string): Promise<ProviderKeyRow[]> {
  const keys = await listProviderKeys(orgId);
  return LLM_PROVIDERS.map((provider) => {
    const existing = keys.find((k) => k.provider === provider);
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      runtimeReady: isRuntimeReady(provider),
      last4: existing?.last4 ?? null,
      hasKey: Boolean(existing),
      updatedAt: existing?.updatedAt ?? null,
    };
  });
}

/**
 * Validate a BYO provider key's format before storing it (#342). The per-provider
 * pattern/minLength/hint now lives in the shared registry (worker/src/providers/registry.ts,
 * #379) as PROVIDER_KEY_PATTERNS — re-exported here (imported above, aliased) under the name
 * this module's callers already use.
 */
export { validateProviderKey };

/**
 * Store (or replace) a Team's key for a provider. The mint-secret → repoint-row →
 * drop-old-secret swap is done atomically in `set_provider_key` under a per-(org,
 * provider) advisory lock, so concurrent replaces can't orphan a Vault secret and
 * a failed swap rolls the new secret back with it. Returns the masked last4.
 */
export async function upsertProviderKey(
  orgId: string,
  userId: string,
  provider: LlmProvider,
  key: string
): Promise<{ last4: string | null } | { error: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { error: await localizeError("providerKeys", "enterKey") };

  // validateProviderKey's message is a follow-up (#407): it's defined in the
  // worker-shared registry (worker/src/providers/registry.ts), which has no
  // locale of its own — localizing it needs the same code+params refactor as
  // the worker-written failure reasons, not a plain catalog lookup.
  const validation = validateProviderKey(provider, trimmed);
  if (validation) return { error: validation };

  // Real provider keys are long; only mask a tail when there's a meaningful one.
  const last4 = trimmed.length >= 4 ? trimmed.slice(-4) : null;

  const { error } = await supabaseAdmin.rpc("set_provider_key", {
    p_org_id: orgId,
    p_provider: provider,
    p_secret: trimmed,
    p_last4: last4,
    p_created_by: userId,
  });

  if (error) {
    await log.error("set_provider_key failed", {
      event: "provider_key.save_failed",
      org_id: orgId,
      provider,
      error,
    });
    return { error: await localizeError("providerKeys", "saveFailed") };
  }

  return { last4 };
}

/** Remove a Team's key for a provider. The row delete fires the secret-purge trigger. */
export async function deleteProviderKeyRow(
  orgId: string,
  provider: LlmProvider
): Promise<{ error?: string }> {
  const { error } = await supabaseAdmin
    .from("provider_keys")
    .delete()
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    await log.error("provider_keys delete failed", {
      event: "provider_key.delete_failed",
      org_id: orgId,
      provider,
      error,
    });
    return { error: await localizeError("providerKeys", "removeFailed") };
  }
  return {};
}
