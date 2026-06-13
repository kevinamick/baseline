import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import { isLlmProvider, type LlmProvider } from "@/lib/llm/providers";

/**
 * Per-Team BYO provider keys in Supabase Vault (#184). The provider_keys row
 * holds only a Vault secret reference and a masked last4 — the plaintext key
 * never lives in a public table, is never returned by any API, and is read back
 * only by the worker (service role) at run time. Mirrors the Connections secret
 * helpers (src/lib/connections/create.ts).
 */

export interface ProviderKeySummary {
  provider: LlmProvider;
  /** Last 4 chars of the stored key, for masked display. Null on legacy rows. */
  last4: string | null;
  updatedAt: string;
}

/** Masked summaries for the settings page — never the key, only its tail. */
export async function listProviderKeys(orgId: string): Promise<ProviderKeySummary[]> {
  const { data } = await supabaseAdmin
    .from("provider_keys")
    .select("provider, last4, updated_at")
    .eq("org_id", orgId);

  return (data ?? [])
    .filter((r) => isLlmProvider(r.provider))
    .map((r) => ({
      provider: r.provider as LlmProvider,
      last4: (r.last4 as string | null) ?? null,
      updatedAt: r.updated_at as string,
    }));
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
