/**
 * Diff a provider's filtered live model list against the shared registry's MODEL_PROVIDER map
 * (#484). Pure/no I/O so it's directly unit-testable — the network fetch + registry import stay
 * in the calling script.
 */
import type { LlmProvider } from "../../worker/src/providers/registry.ts";
import type { IntakeProvider } from "../../worker/src/providers/model-filter.ts";
import type { IgnoreEntry } from "./ignore-list.ts";
import { isIgnored } from "./ignore-list.ts";

export interface ProviderLiveResult {
  provider: LlmProvider;
  /** null when the provider had no key configured (skipped) — distinct from an empty live list. */
  liveIds: string[] | null;
  /** Present when liveIds is null, or when the fetch itself degraded (e.g. non-fatal HTTP error). */
  warning?: string;
}

export interface ModelDiff {
  /** New chat-capable live model ids not yet in the registry, minus ignored ids. */
  added: Record<LlmProvider, string[]>;
  /** Ignore-listed ids that would otherwise have appeared in `added` (reported, not alerted). */
  ignoredNew: Record<LlmProvider, string[]>;
  /** Registry ids missing from a provider's live list — report-only deprecation early-warning. */
  disappeared: Record<LlmProvider, string[]>;
  /** Providers skipped for lack of a configured key. */
  skipped: LlmProvider[];
}

function emptyByProvider(providers: readonly LlmProvider[]): Record<LlmProvider, string[]> {
  return Object.fromEntries(providers.map((p) => [p, [] as string[]])) as Record<
    LlmProvider,
    string[]
  >;
}

export function computeModelDiff(
  results: readonly ProviderLiveResult[],
  registryModelProvider: Record<string, LlmProvider>,
  ignoreEntries: readonly IgnoreEntry[]
): ModelDiff {
  const providers = results.map((r) => r.provider);
  const added = emptyByProvider(providers);
  const ignoredNew = emptyByProvider(providers);
  const disappeared = emptyByProvider(providers);
  const skipped: LlmProvider[] = [];

  const registryByProvider = new Map<LlmProvider, Set<string>>();
  for (const [id, provider] of Object.entries(registryModelProvider)) {
    if (!registryByProvider.has(provider)) registryByProvider.set(provider, new Set());
    registryByProvider.get(provider)!.add(id);
  }

  for (const result of results) {
    const { provider, liveIds } = result;

    if (liveIds === null) {
      skipped.push(provider);
      continue;
    }

    const registryIds = registryByProvider.get(provider) ?? new Set<string>();
    const liveSet = new Set(liveIds);

    for (const id of liveIds) {
      if (registryIds.has(id)) continue;
      // IntakeProvider and LlmProvider are the identical 4-member string union by construction
      // (see model-filter.ts's header comment on why they're declared separately).
      if (isIgnored(ignoreEntries, provider as unknown as IntakeProvider, id)) {
        ignoredNew[provider].push(id);
      } else {
        added[provider].push(id);
      }
    }

    for (const id of registryIds) {
      if (!liveSet.has(id)) disappeared[provider].push(id);
    }
  }

  return { added, ignoredNew, disappeared, skipped };
}

export function hasNewModels(diff: ModelDiff): boolean {
  return Object.values(diff.added).some((ids) => ids.length > 0);
}
