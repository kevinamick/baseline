// App-side reflection-model registry for the Optimization start wizard. The reflection model
// rewrites a Module's prompt each iteration (D7); it's selectable per run, and a run is
// single-provider — the provider that serves the chosen reflect model also serves the judge,
// using the Team's key for that provider (#204).
//
// This mirrors the worker's per-provider model lists (worker/src/providers/models.ts). The app
// and the worker are separate TypeScript projects (the app's tsconfig excludes worker/), so they
// can't share a module yet — extracting a shared package is tracked as #93. Until then this is the
// app's single source for the reflectModel options: one const list → derived type → grouped UI,
// per the single-source-enums convention. The parity test pins each model's provider to the
// worker's MODEL_PROVIDER, so a drift in either file fails CI.
import { LLM_PROVIDERS, PROVIDER_LABELS, type LlmProvider } from "@/lib/llm/providers";

export interface ReflectModelOption {
  id: string;
  provider: LlmProvider;
  label: string;
}

export const REFLECT_MODELS = [
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-8", provider: "anthropic", label: "Opus 4.8 — most capable" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Haiku 4.5 — fastest" },
  { id: "gpt-5", provider: "openai", label: "GPT-5 — most capable" },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 mini — fast" },
  { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro — most capable" },
  { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash — fast" },
  { id: "mistral-large-latest", provider: "mistral", label: "Mistral Large — most capable" },
  { id: "mistral-small-latest", provider: "mistral", label: "Mistral Small — fast" },
] as const satisfies readonly ReflectModelOption[];

export type ReflectModelId = (typeof REFLECT_MODELS)[number]["id"];

// The provider that serves a reflect/generation model — the app mirror of the worker's
// providerForModel(). Single source: derived from REFLECT_MODELS so it can't drift from the
// dropdown. An unknown id falls back to Anthropic (the worker's fail-safe default).
export function providerForReflectModel(id: string): LlmProvider {
  return REFLECT_MODELS.find((m) => m.id === id)?.provider ?? "anthropic";
}

export function reflectModelLabel(id: string): string {
  return REFLECT_MODELS.find((m) => m.id === id)?.label ?? id;
}

// The default reflect (Reflective mode) and generation (Simple mode) model per provider. A run is
// single-provider, so when a Team can't use Anthropic the wizard falls back to its provider's
// defaults. Mirrors the worker's defaultReflectModelForProvider / per-provider judge defaults.
export const PROVIDER_DEFAULT_REFLECT_MODEL: Record<LlmProvider, ReflectModelId> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5",
  google: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
};

// Simple Mode (ADR-0015) reuses the reflect_model column for its generation model but defaults to
// the fast/cheap model: rewrites are mechanical operator applications and Simple runs the model
// far more often than GEPA's one reflection per iteration.
export const PROVIDER_DEFAULT_SIMPLE_MODEL: Record<LlmProvider, ReflectModelId> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5-mini",
  google: "gemini-2.5-flash",
  mistral: "mistral-small-latest",
};

export const DEFAULT_REFLECT_MODEL: ReflectModelId = PROVIDER_DEFAULT_REFLECT_MODEL.anthropic;
export const DEFAULT_SIMPLE_REFLECT_MODEL: ReflectModelId = PROVIDER_DEFAULT_SIMPLE_MODEL.anthropic;

// One provider's selectable models, for an optgroup in the wizard's model dropdown.
export interface ReflectModelGroup {
  provider: LlmProvider;
  label: string;
  models: ReflectModelOption[];
}

/**
 * Group the reflect-model options by provider, keeping only providers the Team can actually run
 * (a BYO key present, or managed-eligible) — the wizard shows nothing a run couldn't use (#204).
 * Provider order follows LLM_PROVIDERS so the grouping is stable.
 */
export function reflectModelGroups(usableProviders: readonly LlmProvider[]): ReflectModelGroup[] {
  return LLM_PROVIDERS.filter((p) => usableProviders.includes(p))
    .map((provider) => ({
      provider,
      label: PROVIDER_LABELS[provider],
      models: REFLECT_MODELS.filter((m) => m.provider === provider),
    }))
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
export const TARGET_MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest (default)" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
] as const;

export type TargetModelId = (typeof TARGET_MODELS)[number]["id"];

// The id tuple, for the zod enum that validates a managed Connection's target_model server-side
// (single source: derived from TARGET_MODELS, never a re-typed union).
export const TARGET_MODEL_IDS = TARGET_MODELS.map((m) => m.id) as [TargetModelId, ...TargetModelId[]];

export const DEFAULT_TARGET_MODEL: TargetModelId = "claude-haiku-4-5-20251001";
