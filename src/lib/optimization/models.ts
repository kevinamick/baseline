// App-side reflection-model registry for the Optimization start wizard. The reflection model
// rewrites a Module's prompt each iteration (D7); it's selectable per run, and a run is
// single-provider — the provider that serves the chosen reflect model also serves the judge,
// using the Team's key for that provider (#204).
//
// The model↔provider facts (which model belongs to which provider, the per-provider judge/reflect
// defaults) come from the shared registry (worker/src/providers/registry.ts, #379) via the
// src/lib/llm/model-prices.ts re-export — there is nothing left to keep in lockstep. This file
// only adds the UI-presentation layer on top: the wizard's dropdown labels/ordering
// (REFLECT_MODELS, TARGET_MODELS) and the grouping/selection helpers the wizard calls.
import { LLM_PROVIDERS, PROVIDER_LABELS, type LlmProvider } from "@/lib/llm/providers";
import {
  type AnyModel,
  type AnthropicModel,
  providerForModel,
  DEFAULT_JUDGE_BY_PROVIDER,
  DEFAULT_REFLECT_BY_PROVIDER,
} from "@/lib/llm/model-prices";

export interface ReflectModelOption {
  id: AnyModel;
  label: string;
}

// Every model in the registry gets a dropdown entry; the id is checked against AnyModel at
// compile time (a typo or a model dropped from the registry fails typecheck here), and the
// provider is always looked up on demand (providerForModel) rather than hand-carried per entry.
export const REFLECT_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest" },
  { id: "gpt-5", label: "GPT-5 — most capable" },
  { id: "gpt-5-mini", label: "GPT-5 mini — fast" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — most capable" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — fast" },
  { id: "mistral-large-latest", label: "Mistral Large — most capable" },
  { id: "mistral-small-latest", label: "Mistral Small — fast" },
] as const satisfies readonly ReflectModelOption[];

export type ReflectModelId = (typeof REFLECT_MODELS)[number]["id"];

// The provider that serves a reflect/generation model. Single source: derives straight from the
// shared registry's model→provider map, so it can't drift from the worker's runtime resolution.
// An unknown id falls back to Anthropic (the registry's own fail-safe default).
export function providerForReflectModel(id: string): LlmProvider {
  return providerForModel(id);
}

export function reflectModelLabel(id: string): string {
  return REFLECT_MODELS.find((m) => m.id === id)?.label ?? id;
}

// The default reflect (Reflective mode) and generation (Simple mode) model per provider. A run is
// single-provider, so when a Team can't use Anthropic the wizard falls back to its provider's
// defaults. Directly aliased to the shared registry's DEFAULT_REFLECT_BY_PROVIDER /
// DEFAULT_JUDGE_BY_PROVIDER (same import as the worker uses) — no separate app copy to drift.
export const PROVIDER_DEFAULT_REFLECT_MODEL: Record<LlmProvider, ReflectModelId> =
  DEFAULT_REFLECT_BY_PROVIDER;

// Simple Mode (ADR-0015) reuses the reflect_model column for its generation model but defaults to
// the fast/cheap model: rewrites are mechanical operator applications and Simple runs the model
// far more often than GEPA's one reflection per iteration.
export const PROVIDER_DEFAULT_SIMPLE_MODEL: Record<LlmProvider, ReflectModelId> =
  DEFAULT_JUDGE_BY_PROVIDER;

// The per-provider judge model the worker uses. Equals PROVIDER_DEFAULT_SIMPLE_MODEL today (both
// pick the fast model per provider); a separate named constant so call sites can express intent.
export const PROVIDER_DEFAULT_JUDGE_MODEL: Record<LlmProvider, ReflectModelId> =
  PROVIDER_DEFAULT_SIMPLE_MODEL;

export const DEFAULT_REFLECT_MODEL: ReflectModelId = PROVIDER_DEFAULT_REFLECT_MODEL.anthropic;
export const DEFAULT_SIMPLE_REFLECT_MODEL: ReflectModelId = PROVIDER_DEFAULT_SIMPLE_MODEL.anthropic;

// One selectable model in the wizard's dropdown. Curated entries carry the hand-written label;
// a live-listed BYO entry (#485) carries the raw model id as its label and `live: true` so the
// wizard can render it distinguishably ("latest from provider"). Deliberately looser than
// ReflectModelOption: a live id is whatever the provider currently serves, not an AnyModel.
export interface ReflectModelChoice {
  id: string;
  label: string;
  live?: boolean;
}

// One provider's selectable models, for an optgroup in the wizard's model dropdown.
export interface ReflectModelGroup {
  provider: LlmProvider;
  label: string;
  models: ReflectModelChoice[];
}

/**
 * Group the reflect-model options by provider, keeping only providers the Team can actually run
 * (a BYO key present, or managed-eligible) — the wizard shows nothing a run couldn't use (#204).
 * Provider order follows LLM_PROVIDERS so the grouping is stable.
 *
 * `liveModels` (#485) appends a BYO provider's live-listed model ids — those not already curated
 * for that provider — after its curated entries, flagged `live: true`. The caller (the
 * optimizations page via src/lib/llm/live-models.ts) only supplies entries for providers whose
 * key mode is BYO; managed-mode providers stay curated-only.
 */
export function reflectModelGroups(
  usableProviders: readonly LlmProvider[],
  liveModels?: Partial<Record<LlmProvider, readonly string[]>>,
): ReflectModelGroup[] {
  return LLM_PROVIDERS.filter((p) => usableProviders.includes(p))
    .map((provider) => {
      const curated = REFLECT_MODELS.filter((m) => providerForModel(m.id) === provider);
      const curatedIds = new Set<string>(curated.map((m) => m.id));
      const live = (liveModels?.[provider] ?? [])
        .filter((id) => !curatedIds.has(id))
        .map((id) => ({ id, label: id, live: true as const }));
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        models: [...curated, ...live],
      };
    })
    .filter((g) => g.models.length > 0);
}

/**
 * Pick a valid initial model from the usable providers: the preferred model if its provider is
 * usable, else the first usable provider's default (Reflective or Simple). Returns null when the
 * Team can use no provider at all (the wizard then shows the no-usable-provider notice).
 */
export function defaultReflectModelFor(
  usableProviders: readonly LlmProvider[],
  preferred: ReflectModelId,
  defaults: Record<LlmProvider, ReflectModelId>,
): ReflectModelId | null {
  if (usableProviders.includes(providerForReflectModel(preferred))) return preferred;
  const first = LLM_PROVIDERS.find((p) => usableProviders.includes(p));
  return first ? defaults[first] : null;
}

// App-side target-model registry for a Managed Agent (#293): the Anthropic model the
// "Paste a prompt" System runs the optimized prompt on. Managed Agents stay Anthropic-only for now
// (#204): the legacy eval path reuses the judge's Anthropic key for the target call, so widening
// target models to other providers needs separate target-key resolution there first. Haiku leads —
// the managed path's headline is fast + cheap — and is the default; the order here is the dropdown order.
// Typed against AnthropicModel (from the shared registry) so an id outside Anthropic's model list
// fails typecheck here, rather than only being caught by a runtime parity test.
export const TARGET_MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest (default)" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
] as const satisfies readonly { id: AnthropicModel; label: string }[];

export type TargetModelId = (typeof TARGET_MODELS)[number]["id"];

// The id tuple, for the zod enum that validates a managed Connection's target_model server-side
// (single source: derived from TARGET_MODELS, never a re-typed union).
export const TARGET_MODEL_IDS = TARGET_MODELS.map((m) => m.id) as [TargetModelId, ...TargetModelId[]];

export const DEFAULT_TARGET_MODEL: TargetModelId = "claude-haiku-4-5-20251001";
