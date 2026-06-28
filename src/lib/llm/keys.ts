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
 * Validate a BYO provider key's format before storing it (#342). Each LLM
 * provider issues keys with a recognizable prefix and minimum length; rejecting
 * values that can't possibly be real keys prevents a fake/garbage key from being
 * stored and silently used instead of the managed fallback. Returns an error
 * message string when invalid, or null when the key passes. The checks are
 * deliberately conservative — prefix + minimum length — so legitimate key
 * formats (including newer variants) aren't rejected, while obvious fakes are.
 */
const PROVIDER_KEY_PATTERNS: Record<
  LlmProvider,
  { pattern: RegExp; minLength: number; label: string; hint: string }
> = {
  anthropic: { pattern: /^sk-ant-/, minLength: 20, label: "Anthropic", hint: 'start with "sk-ant-"' },
  openai: { pattern: /^sk-/, minLength: 20, label: "OpenAI", hint: 'start with "sk-"' },
  google: { pattern: /^AIza/, minLength: 20, label: "Google", hint: 'start with "AIza"' },
  mistral: { pattern: /^[A-Za-z0-9]{16,}$/, minLength: 16, label: "Mistral", hint: "be a long alphanumeric string" },
};

export function validateProviderKey(
  provider: LlmProvider,
  key: string
): string | null {
  const spec = PROVIDER_KEY_PATTERNS[provider];
  if (key.length < spec.minLength) {
    return `That ${spec.label} API key looks too short. Check that you copied the full key.`;
  }
  if (!spec.pattern.test(key)) {
    return `That doesn't look like a valid ${spec.label} API key — ${spec.label} keys ${spec.hint}. Check that you copied the right key.`;
  }
  return null;
}

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
  if (!trimmed) return { error: "Enter a provider key" };

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
    return { error: "Failed to save the provider key" };
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
    return { error: "Failed to remove the provider key" };
  }
  return {};
}
