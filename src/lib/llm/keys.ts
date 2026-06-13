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
 * Store (or replace) a Team's key for a provider. Creates the new Vault secret
 * first, then upserts the (org, provider) row to point at it. A replace leaves
 * the old secret unreferenced — the delete trigger only fires on row DELETE, not
 * UPDATE — so the old secret is purged explicitly once the swap succeeds. If the
 * upsert fails, the just-created secret is cleaned up so nothing is orphaned.
 */
export async function upsertProviderKey(
  orgId: string,
  userId: string,
  provider: LlmProvider,
  key: string
): Promise<{ last4: string } | { error: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { error: "Enter a provider key" };

  // The secret this row points at now, if any — deleted after a successful swap.
  const { data: existing } = await supabaseAdmin
    .from("provider_keys")
    .select("secret_id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();

  const { data: secretId, error: secretError } = await supabaseAdmin.rpc(
    "create_provider_secret",
    { p_secret: trimmed, p_name: `pk:${orgId}:${provider}:${Date.now()}` }
  );
  if (secretError || !secretId) {
    await log.error("create_provider_secret failed", {
      event: "provider_key.secret_create_failed",
      org_id: orgId,
      provider,
      error: secretError,
    });
    return { error: "Failed to store the provider key" };
  }

  const last4 = trimmed.slice(-4);
  const { error: upsertError } = await supabaseAdmin.from("provider_keys").upsert(
    {
      org_id: orgId,
      provider,
      secret_id: secretId as string,
      last4,
      created_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,provider" }
  );

  if (upsertError) {
    await log.error("provider_keys upsert failed", {
      event: "provider_key.upsert_failed",
      org_id: orgId,
      provider,
      error: upsertError,
    });
    // The row never took the new secret — remove it so Vault isn't orphaned.
    await supabaseAdmin
      .rpc("delete_provider_secret", { p_secret_id: secretId as string })
      .then(({ error }) => {
        if (error)
          void log.error("orphaned provider secret cleanup failed", {
            event: "provider_key.secret_cleanup_failed",
            error,
          });
      });
    return { error: "Failed to save the provider key" };
  }

  // Swap committed — purge the prior secret the row no longer references.
  if (existing?.secret_id && existing.secret_id !== secretId) {
    await supabaseAdmin
      .rpc("delete_provider_secret", { p_secret_id: existing.secret_id as string })
      .then(({ error }) => {
        if (error)
          void log.error("replaced provider secret cleanup failed", {
            event: "provider_key.secret_cleanup_failed",
            error,
          });
      });
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
