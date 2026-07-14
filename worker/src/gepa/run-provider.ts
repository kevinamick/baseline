// The provider an Optimization Run's reflect/generation (and therefore judge) calls resolve to
// (#485). One pure decision, used by every reflect/judge call site in gepa/activities.ts:
//
//   - `reflect_provider` set (a run created after #485, stamped by createOptimizationRun after
//     server-side model/provider validation) → trust it. This is what lets a live-listed,
//     non-registry model route to the right provider instead of providerForModel's Anthropic
//     fallback.
//   - `reflect_provider` null (pre-#485 rows, or any writer that omits it) → derive from the
//     model via the registry map, exactly the pre-#485 behavior — old rows and registry models
//     resolve byte-for-byte as before.
//
// A stored value that isn't a known provider id (impossible via the column's CHECK constraint,
// but this stays total) also falls back to the registry derivation.

import { isLlmProvider, providerForModel, type LlmProvider } from "../providers/registry.js";

export interface ReflectProviderSource {
  reflect_model: string;
  reflect_provider: string | null;
}

export function reflectProviderForRun(run: ReflectProviderSource): LlmProvider {
  return isLlmProvider(run.reflect_provider)
    ? run.reflect_provider
    : providerForModel(run.reflect_model);
}
