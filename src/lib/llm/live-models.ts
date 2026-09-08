import "server-only";
// The Team's BYO provider key is read via the shared, org-scoped `readUsableProviderSecret`
// (./provider-secret.ts) — the same usable-secret definition the pre-run key-mode estimate uses,
// so live-list eligibility can't drift from it (#488).
import { readUsableProviderSecret } from "@/lib/llm/provider-secret";
import { envProviderKey } from "@/lib/llm/key-gate";
import { isRuntimeReady, type LlmProvider } from "@/lib/llm/providers";
import { MODEL_PROVIDER } from "@/lib/llm/model-prices";
import { log } from "@/lib/logging/server";
// The shared chat-capable filter policy (#484) — ONE definition of "is this listed model a chat
// model" for the detection bot and this module; import-free by design (registry convention), so
// the Turbopack extensionless-import sharp edge never applies to it.
import { extractChatCapableModelIds } from "../../../worker/src/providers/model-filter";

/**
 * Live provider model listing for BYO Teams (#485).
 *
 * Given an org and a provider the Team holds a USABLE BYO key for, list the chat-capable models
 * that provider currently serves — using the Team's OWN Vault-stored key, never the managed
 * platform key (managed model selection stays curated-registry-only; the managed key must not be
 * spent on a per-tenant catalog fetch). The wizard appends these to the curated optgroups, and
 * createOptimizationRun re-validates a submitted model/provider pair against this same list.
 *
 * Progressive enhancement, never blocking: a short timeout bounds the fetch, and ANY failure —
 * no usable BYO key, HTTP error, network error, timeout, unparseable payload — resolves to an
 * empty list, which renders exactly today's curated experience. This module never throws.
 *
 * Hosts are fixed literals per provider (the #222 host-pinning guarantee), with the operator-only
 * `*_API_BASE_OVERRIDE` env vars (deploy env, never tenant-influenced) as the dev/e2e escape
 * hatch — the same convention as worker/src/providers/google.ts, whose GOOGLE_API_BASE_OVERRIDE
 * this module shares.
 *
 * Cache: a short per-org+provider in-memory cache keeps wizard opens and the server action's
 * re-validation from hammering provider APIs. Entries carry MODEL IDS ONLY — never key material.
 */

export const LIVE_MODELS_TIMEOUT_MS = 3_000;
// Success entries live long enough to cover a wizard session + the submit's re-validation;
// failure/no-key entries stay short so a provider recovering (or a key just added) shows up
// quickly, while an actively-polled page still can't hammer an unreachable provider.
export const LIVE_MODELS_SUCCESS_TTL_MS = 5 * 60_000;
export const LIVE_MODELS_FAILURE_TTL_MS = 30_000;

// Matches the pinned SDK version in worker/src/providers/anthropic.ts (and the detection
// script's listing call, scripts/detect-new-models.mts).
const ANTHROPIC_VERSION = "2023-06-01";

interface ListModelsRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * The list-models request per provider: fixed literal host (production default) + auth scheme,
 * honoring the operator-only override. Anthropic/Google cap+paginate their listings — request the
 * maximum single-page size rather than paginating (both catalogs are far under it; a provider
 * crossing it degrades to a shorter live list, never an error — same trade-off as #484).
 */
function listModelsRequest(provider: LlmProvider, apiKey: string): ListModelsRequest {
  switch (provider) {
    case "anthropic": {
      const base = process.env.ANTHROPIC_API_BASE_OVERRIDE ?? "https://api.anthropic.com/v1";
      return {
        url: `${base}/models?limit=1000`,
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      };
    }
    case "openai": {
      const base = process.env.OPENAI_API_BASE_OVERRIDE ?? "https://api.openai.com/v1";
      return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } };
    }
    case "google": {
      // GOOGLE_API_BASE_OVERRIDE is the pre-existing operator escape hatch
      // (worker/src/providers/google.ts) and already IS the models-collection base.
      // The key rides a header, never the URL, so it can't land in a log line.
      const base =
        process.env.GOOGLE_API_BASE_OVERRIDE ??
        "https://generativelanguage.googleapis.com/v1beta/models";
      return { url: `${base}?pageSize=1000`, headers: { "x-goog-api-key": apiKey } };
    }
    case "mistral": {
      const base = process.env.MISTRAL_API_BASE_OVERRIDE ?? "https://api.mistral.ai/v1";
      return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } };
    }
  }
}

/**
 * The Team's USABLE BYO key for a provider (non-empty after trim), or null. Delegates the row +
 * `get_provider_secret` + trim usability sequence to the shared `readUsableProviderSecret`
 * (./provider-secret.ts) — the SAME definition the pre-run key-mode estimate/reserve uses
 * (./key-gate.ts), so wizard live-list eligibility can't drift from it (#488). Unlike this module's
 * other failure modes, ANY read error here simply yields null — no key, no fetch, never a throw
 * (progressive enhancement) — so the shared helper's row-read throw is caught back to null.
 * Deliberately NO managed fallback of any kind: a Team whose key mode is managed gets no live list
 * (curated only).
 */
async function readUsableByoKey(orgId: string, provider: LlmProvider): Promise<string | null> {
  try {
    return (await readUsableProviderSecret(orgId, provider)) ?? envProviderKey(provider);
  } catch {
    return envProviderKey(provider);
  }
}

interface CacheEntry {
  ids: readonly string[];
  expiresAt: number;
}

// Per-org+provider cache. Model ids only — NEVER key material (the key is read, used for the one
// fetch, and dropped; nothing key-shaped is stored or returned).
const cache = new Map<string, CacheEntry>();

function cacheKey(orgId: string, provider: LlmProvider): string {
  // `:` is an unambiguous separator here — org ids are UUIDs (no colon), so `<uuid>:<provider>`
  // never collides. (A raw NUL byte here made git classify this whole file as binary/unreviewable.)
  return `${orgId}:${provider}`;
}

/** Test-only: reset the module cache between tests. */
export function clearLiveModelsCache(): void {
  cache.clear();
}

/**
 * The outcome of one live-listing attempt, kept as three distinct states so the authoritative
 * submit-time gate (`isModelAvailableForProvider`) can tell them apart:
 *   - `ok`     — the provider answered; `ids` is its current chat-capable catalog.
 *   - `no_key` — the Team has no usable BYO key for this provider (nothing was fetched).
 *   - `error`  — the provider couldn't be reached / answered with an HTTP or parse error.
 * `listLiveModels` (the wizard's cached, display path) collapses `no_key`/`error` to `[]`, exactly
 * today's curated experience; the gate keeps the distinction (a transient `error` must NOT refuse a
 * model the user legitimately picked).
 */
type LiveModelsOutcome =
  | { status: "ok"; ids: string[] }
  | { status: "no_key" }
  | { status: "error" };

async function fetchLiveModels(
  orgId: string,
  provider: LlmProvider,
): Promise<LiveModelsOutcome> {
  try {
    const apiKey = await readUsableByoKey(orgId, provider);
    if (!apiKey) return { status: "no_key" };

    const { url, headers } = listModelsRequest(provider, apiKey);
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(LIVE_MODELS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await log.warn("live model listing failed", {
        event: "live_models.fetch_failed",
        provider,
        org_id: orgId,
        status: res.status,
      });
      return { status: "error" };
    }
    const payload: unknown = await res.json();
    return { status: "ok", ids: extractChatCapableModelIds(provider, payload) };
  } catch (err) {
    // Timeout, network failure, JSON parse error, or an unexpected key-read throw — all collapse
    // to a couldn't-reach error (progressive enhancement; the wizard shows curated models only).
    await log.warn("live model listing errored", {
      event: "live_models.fetch_failed",
      provider,
      org_id: orgId,
      error: err,
    });
    return { status: "error" };
  }
}

/**
 * The chat-capable model ids `provider` currently serves for this org's BYO key, or `[]` when the
 * Team has no usable BYO key for it (managed/blocked modes see curated models only) or the
 * listing fails in any way. Cached per org+provider. Never throws.
 */
export async function listLiveModels(
  orgId: string,
  provider: LlmProvider,
): Promise<readonly string[]> {
  if (!isRuntimeReady(provider)) return [];
  const key = cacheKey(orgId, provider);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.ids;

  const outcome = await fetchLiveModels(orgId, provider);
  const ok = outcome.status === "ok";
  const ids = ok ? outcome.ids : [];
  cache.set(key, {
    ids,
    expiresAt: Date.now() + (ok ? LIVE_MODELS_SUCCESS_TTL_MS : LIVE_MODELS_FAILURE_TTL_MS),
  });
  return ids;
}

/**
 * Live model ids for a set of BYO-mode providers, fetched in parallel (each bounded by the module
 * timeout). Providers whose listing is empty are omitted, so the wizard payload stays minimal.
 * The caller passes only providers whose key mode is BYO (usableProvidersForOrg's byo entries) —
 * a non-BYO provider would resolve to [] here anyway (no key, no fetch), belt and suspenders.
 */
export async function liveModelsByProviderForOrg(
  orgId: string,
  byoProviders: readonly LlmProvider[],
): Promise<Partial<Record<LlmProvider, string[]>>> {
  const lists = await Promise.all(byoProviders.map((p) => listLiveModels(orgId, p)));
  const out: Partial<Record<LlmProvider, string[]>> = {};
  byoProviders.forEach((provider, i) => {
    if (lists[i].length > 0) out[provider] = [...lists[i]];
  });
  return out;
}

/**
 * Server-side re-validation for a submitted model/provider pair (#485), the authoritative
 * submit-time gate. Agreement with the worker's execution-time resolution is the contract:
 *
 *   - A registry model of THIS provider passes without any fetch.
 *   - A registry model of ANOTHER provider is refused — the worker would reject that exact pair
 *     (`allowUnlistedReflectModel` only admits ids the registry doesn't know) and silently run the
 *     provider's default instead, so validation and execution must agree here (finding #8).
 *   - A non-registry id is checked against the provider's live list, re-fetched FRESH (the module
 *     cache is deliberately bypassed): this gate must reflect the CURRENT BYO-key state, not a
 *     stale success cached at page render, so a key deleted since then refuses cleanly rather than
 *     letting a run be created that the worker later fails closed (finding #3).
 *
 * The fresh fetch distinguishes "the provider says this model doesn't exist" (refuse) from
 * "we couldn't reach the provider right now" (a transient blip must NOT refuse a model the user
 * legitimately selected, finding #5): on a couldn't-reach error we admit the model and let the
 * worker's own resolution be authoritative at execution time. A Team with no usable BYO key can't
 * have a live list at all, so a non-registry id there is refused (managed mode stays curated).
 */
export async function isModelAvailableForProvider(
  orgId: string,
  provider: LlmProvider,
  model: string,
): Promise<boolean> {
  const registryProvider = MODEL_PROVIDER[model] as LlmProvider | undefined;
  if (registryProvider === provider) return true;
  if (registryProvider !== undefined) return false;

  const outcome = await fetchLiveModels(orgId, provider);
  if (outcome.status === "no_key") return false;
  // Fail OPEN on a transient list-models error (a 5xx / network blip): admit the model rather than
  // refuse a legitimately-picked one during a provider hiccup, and let the worker's execution-time
  // resolution be authoritative. This is a DELIBERATE trade-off (Kevin confirmed, #488): the cost
  // is that a genuinely-invalid id slipped in during a blip creates a run that fails at execution —
  // but the worker's terminal-marker path (metered-call.ts's MODEL_UNAVAILABLE, #488) now catches
  // exactly that, failing the run fast with a comprehensible reason instead of a retry-storm. Do
  // NOT flip this to fail-closed; refusing a valid model on every provider blip is the worse UX.
  if (outcome.status === "error") return true;
  return outcome.ids.includes(model);
}
