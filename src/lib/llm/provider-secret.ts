import "server-only";
// provider_keys reads here stay on the raw admin client (not tenantDb): this is an orgId-param lib
// module, not a ctx-holding action, and tenantDb is ctx-only by design (#207). The read is
// org-scoped by an explicit `.eq("org_id", orgId)`. Same posture as ./key-gate.ts / ./live-models.ts.
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { LlmProvider } from "@/lib/llm/providers";

/**
 * The Team's USABLE BYO secret STRING for one provider (non-empty after trim), or null when there
 * is no row, its Vault secret is empty/whitespace, or the Vault RPC can't read it. The ONE
 * definition of the `provider_keys` → `get_provider_secret` → trim usability sequence, shared by
 * the pre-run key-mode estimate (`resolveKeyModeForEstimate`, ./key-gate.ts) and the wizard's
 * live-model eligibility (./live-models.ts) so the two can never drift on what counts as a usable
 * key (#488). Mirrors the worker's `readUsableByoKey` (worker/src/providers/resolve-key.ts)
 * usability rule (#371).
 *
 * Throws only on a hard `provider_keys` ROW read error — fail closed by propagating, so the
 * estimate never silently waves a run through on a DB blip; the never-throwing live-models path
 * catches it. A secret-RPC error is treated as unusable (null), mirroring key-gate's
 * `isSecretUsable`, since a Vault read that fails must not count the key as BYO.
 */
export async function readUsableProviderSecret(
  orgId: string,
  provider: LlmProvider,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("provider_keys")
    .select("secret_id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  const secretId = (data as { secret_id: string | null } | null)?.secret_id ?? null;
  if (!secretId) return null;
  const { data: secret, error: secErr } = await supabaseAdmin.rpc("get_provider_secret", {
    p_secret_id: secretId,
  });
  if (secErr) return null;
  return (secret as string | null)?.trim() || null;
}
