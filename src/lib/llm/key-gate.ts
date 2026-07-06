import "server-only";
// provider_keys reads here stay on the raw admin client (not tenantDb): these are
// orgId-param lib functions, not ctx-holding actions, and tenantDb is ctx-only by
// design (#207). Each read is already org-scoped by an explicit `.eq("org_id", orgId)`.
// See the TENANT SCOPING note in ./keys.ts.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/billing/plans";
import { getBillingState } from "@/lib/billing/state";
import { isManagedPaymentBlocked } from "@/lib/billing/managed-spend";
import { RUNTIME_READY_PROVIDERS, type LlmProvider } from "@/lib/llm/providers";
import { ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";

/**
 * Whether a Team's eval run must be blocked for want of a provider key (#184).
 *
 * Free Teams have no managed-key fallback (no card on file → unbounded token
 * exposure, ADR-0008), so they must bring their own key for some runtime-ready
 * provider or their runs fail closed. Paid Teams fall back to the managed
 * platform key and are never blocked here — `managedMarkupPct != null` is
 * exactly the "managed allowed" signal (Free is null; Builder/Scale are non-null).
 *
 * "Has a key" means a key for any runtime-ready provider, not Anthropic
 * specifically: the eval judge is provider-aware (worker.ts's `resolveEvalJudge`
 * judges on whatever runtime-ready provider the Team has a BYO key for, at the
 * Team's own cost), so a Free Team with only an OpenAI/Google/Mistral key runs
 * the judge on that key. The Anthropic pin applies only to the managed path
 * (paid Teams with no BYO key), where the platform bears the cost and judges on
 * the one provider it prices — that path is never blocked here. Fails closed:
 * an unreadable key table leaves a Free Team blocked, never waved through.
 */
export async function evalRunBlockedForMissingKey(orgId: string): Promise<boolean> {
  const { plan } = await getBillingState(orgId);
  if (PLANS[plan].managedMarkupPct != null) return false;
  return !(await hasRuntimeProviderKey(orgId));
}

/**
 * Whether a provider's Vault secret is a USABLE BYO key (non-empty after trim). The one
 * definition of "usable secret" shared by every key-mode resolver below, mirroring the worker's
 * `readUsableByoKey` (`worker/src/providers/resolve-key.ts`) so the app's pre-run estimate and the
 * worker's run-time resolution can't drift on what counts as usable (#371). Fails closed on an
 * unreadable secret — treated as unusable, never waved through as BYO.
 */
async function isSecretUsable(secretId: string | null): Promise<boolean> {
  if (!secretId) return false;
  const { data: secret, error } = await supabaseAdmin.rpc("get_provider_secret", {
    p_secret_id: secretId,
  });
  if (error) return false;
  return !!(secret as string | null)?.trim();
}

/**
 * Any runtime-ready provider with a USABLE BYO key, mirroring the worker's `resolveEvalJudge` /
 * `firstUsableByoProvider` (`worker/src/providers/resolve-key.ts`): both scan
 * `RUNTIME_READY_PROVIDERS` and skip a row whose secret is empty/whitespace rather than counting
 * it as BYO (#371) — this only needs "does ANY usable key exist" (not which one), so it returns as
 * soon as the first usable row is found, in no particular provider order.
 */
async function hasRuntimeProviderKey(orgId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("provider_keys")
    .select("secret_id")
    .eq("org_id", orgId)
    .in("provider", RUNTIME_READY_PROVIDERS as unknown as string[]);
  for (const row of (data ?? []) as { secret_id: string | null }[]) {
    if (await isSecretUsable(row.secret_id)) return true;
  }
  return false;
}

/**
 * How a managed-metering run resolves its key for a given provider (#185).
 * Single source: the type is derived from this const, and every comparison uses
 * a member (KEY_MODE.managed) rather than a bare string literal — no duplicated
 * union (the project's enum convention). NB this is the APP's pre-run estimate
 * mode; the worker's run-time `ResolvedKey.source` ("byo"|"managed"|"none") is a
 * separate concept (it has no "blocked" — Free is caught earlier) and lives in
 * the worker package until the shared-package extraction (#93) unifies them.
 */
export const KEY_MODE = {
  byo: "byo",
  managed: "managed",
  blocked: "blocked",
} as const;
export type KeyMode = (typeof KEY_MODE)[keyof typeof KEY_MODE];

/**
 * Resolve a Team's key mode for one provider, mirroring the worker's run-time
 * precedence (`resolveProviderKey` in `worker/src/providers/resolve-key.ts`) so the
 * app's pre-run dollar estimate and managed-spend reservation agree with what the
 * worker will do:
 *   - a USABLE BYO key for the provider → "byo" (any plan; the customer's tokens, never metered)
 *   - no usable BYO key + paid plan (managedMarkupPct != null) → "managed" (metered, capped)
 *   - no usable BYO key + Free → "blocked" (no managed fallback, ADR-0008)
 * "Usable" mirrors the worker exactly (#371): a stored row whose Vault secret is
 * empty/whitespace does NOT count as BYO — it falls through to the same
 * managed/blocked precedence as no row at all, matching `resolveProviderKey`'s
 * `readUsableByoKey`. The worker stays the run-time source of truth; this only
 * drives the estimate and the pre-run reserve (#185).
 */
export async function resolveKeyModeForEstimate(
  orgId: string,
  provider: LlmProvider,
): Promise<KeyMode> {
  const { data, error } = await supabaseAdmin
    .from("provider_keys")
    .select("secret_id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  if (await isSecretUsable((data as { secret_id: string | null } | null)?.secret_id ?? null)) {
    return KEY_MODE.byo;
  }

  const { plan } = await getBillingState(orgId);
  return PLANS[plan].managedMarkupPct != null ? KEY_MODE.managed : KEY_MODE.blocked;
}

/**
 * The key mode the EVAL JUDGE will run under, mirroring the worker's `resolveEvalJudge`
 * (worker/src/providers/resolve-key.ts) (#371). An eval run carries no per-run model, so the
 * worker judges on whatever runtime-ready provider the Team has a USABLE BYO key for (Anthropic
 * wins when several exist, via `hasRuntimeProviderKey`/`isSecretUsable` scanning
 * `RUNTIME_READY_PROVIDERS` in order — this only needs "does any usable key exist," not which
 * provider, since the estimate doesn't need to name it); only a Team with NO usable BYO key for
 * any runtime-ready provider falls back to the managed Anthropic key (paid) or is blocked (Free).
 *
 * This differs from `resolveKeyModeForEstimate(orgId, ESTIMATE_JUDGE_PROVIDER)`, which only
 * checks the *Anthropic* key: that over-reports "managed" for a Team whose judge will
 * actually run BYO on a non-Anthropic key (e.g. BYO OpenAI). Keying the managed-spend
 * reserve off Anthropic alone therefore reserves managed dollars for a run the worker meters
 * as BYO — a phantom reservation against the cap (#358). The managed-spend ESTIMATE still
 * prices the Anthropic judge model (managed judging pins to Anthropic); only the byo/managed
 * DECISION considers every runtime-ready key here, so it agrees with what the worker does.
 */
export async function resolveJudgeKeyModeForEstimate(orgId: string): Promise<KeyMode> {
  if (await hasRuntimeProviderKey(orgId)) return KEY_MODE.byo;
  const { plan } = await getBillingState(orgId);
  return PLANS[plan].managedMarkupPct != null ? KEY_MODE.managed : KEY_MODE.blocked;
}

/**
 * Batched form of resolveKeyModeForEstimate for a whole set of providers (#204).
 * Resolving every runtime-ready provider one-by-one fans out 2N round trips — a
 * provider_keys read plus a getBillingState per provider, all for the same org
 * (the optimizations wizard's usableProvidersForOrg did exactly this). This does
 * one `.in()` provider_keys read and one getBillingState for the whole set, then
 * a secret-usability check only for the providers that have a row (#371 — same
 * usability treatment as the single-provider form, since a UI that offered a
 * blank-secret provider as "byo" would mislead the wizard, not just the estimate)
 * before applying the identical per-provider precedence in memory. Fails closed the
 * same way: an unreadable key table throws rather than silently waving providers in.
 */
export async function resolveKeyModesForEstimate(
  orgId: string,
  providers: readonly LlmProvider[],
): Promise<Map<LlmProvider, KeyMode>> {
  const [keys, { plan }] = await Promise.all([
    supabaseAdmin
      .from("provider_keys")
      .select("provider, secret_id")
      .eq("org_id", orgId)
      .in("provider", providers as unknown as string[]),
    getBillingState(orgId),
  ]);
  if (keys.error) throw keys.error;
  const secretIdByProvider = new Map(
    ((keys.data ?? []) as { provider: string; secret_id: string | null }[]).map((r) => [
      r.provider,
      r.secret_id,
    ]),
  );
  const managedAllowed = PLANS[plan].managedMarkupPct != null;
  const modes = new Map<LlmProvider, KeyMode>();
  for (const provider of providers) {
    const usable = await isSecretUsable(secretIdByProvider.get(provider) ?? null);
    modes.set(
      provider,
      usable
        ? KEY_MODE.byo
        : managedAllowed
          ? KEY_MODE.managed
          : KEY_MODE.blocked,
    );
  }
  return modes;
}

/**
 * Whether a run that WOULD use a managed key must be blocked because a managed-
 * token payment failed (#186, ADR-0008 Meter 2). Fail-closed for managed runs
 * only: a Team running BYO (its own key for the provider) resolves to
 * KEY_MODE.byo here and is never blocked, and a Free Team is already refused by
 * the missing-key gate. The block clears automatically when the declined
 * threshold invoice is paid (the webhook nulls the mirror flag). Resolved for
 * the judge model's provider, matching what the worker meters.
 */
export async function managedRunBlockedForPayment(
  orgId: string,
  provider: LlmProvider = ESTIMATE_JUDGE_PROVIDER,
): Promise<boolean> {
  const mode = await resolveKeyModeForEstimate(orgId, provider);
  if (mode !== KEY_MODE.managed) return false;
  return isManagedPaymentBlocked(orgId);
}
