// Single source for the LLM models the worker can call, and the model→provider mapping key
// resolution and metering derive from (#184, #204). One const list per provider; the types,
// the per-provider membership guards, and the unified MODEL_PROVIDER map are all derived from
// them — no duplicated unions (the project's enum convention). The judge stays cheap/high-volume
// (a provider's fast model); reflection runs on a provider's most-capable model (D7), overridable
// per Optimization Run via optimization_runs.reflect_model.
//
// App mirror: src/lib/optimization/models.ts (separate TS project, #93). The app's parity test
// pins its model→provider mapping to MODEL_PROVIDER here, so a drift in either file fails CI.

import { type LlmProvider } from "./provider-list.js";

export const ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
] as const;

export const OPENAI_MODELS = ["gpt-5", "gpt-5-mini"] as const;

export const GOOGLE_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export type GoogleModel = (typeof GOOGLE_MODELS)[number];

export function isAnthropicModel(value: string): value is AnthropicModel {
  return (ANTHROPIC_MODELS as readonly string[]).includes(value);
}

export function isOpenAIModel(value: string): value is OpenAIModel {
  return (OPENAI_MODELS as readonly string[]).includes(value);
}

export function isGoogleModel(value: string): value is GoogleModel {
  return (GOOGLE_MODELS as readonly string[]).includes(value);
}

// The model→provider map, built once from the per-provider lists. Single source: every lookup
// (key resolution, metering, the runtime client factory) derives from it, so a model can only
// ever map to one provider and adding a model is a one-line list edit.
export const MODEL_PROVIDER: Record<string, LlmProvider> = {
  ...Object.fromEntries(ANTHROPIC_MODELS.map((m) => [m, "anthropic" as const])),
  ...Object.fromEntries(OPENAI_MODELS.map((m) => [m, "openai" as const])),
  ...Object.fromEntries(GOOGLE_MODELS.map((m) => [m, "google" as const])),
};

/** True when the model is in the registry (any provider) — the managed-agent target-model guard. */
export function isKnownModel(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_PROVIDER, value);
}

/**
 * The provider that serves a given model (#184, #204). Key resolution and metering derive the
 * provider from the model a run will actually call, rather than hardcoding one at the call site.
 * A model not in the registry resolves to the default provider (Anthropic) — a fail-safe so a
 * typo'd optimization_runs.reflect_model still finds *a* key and surfaces a clean model error at
 * the provider rather than crashing key resolution; the judge/reflect defaults are Anthropic, so
 * the default path is always correct.
 */
export function providerForModel(model: string): LlmProvider {
  return MODEL_PROVIDER[model] ?? "anthropic";
}

// Per-provider defaults. Judge is the fast/cheap high-volume model; reflect is the most capable.
export const DEFAULT_JUDGE_MODEL: AnthropicModel = "claude-haiku-4-5-20251001";
export const DEFAULT_REFLECT_MODEL: AnthropicModel = "claude-sonnet-4-6";

const DEFAULT_JUDGE_BY_PROVIDER: Record<LlmProvider, string> = {
  anthropic: DEFAULT_JUDGE_MODEL,
  openai: "gpt-5-mini",
  google: "gemini-2.5-flash",
};

const DEFAULT_REFLECT_BY_PROVIDER: Record<LlmProvider, string> = {
  anthropic: DEFAULT_REFLECT_MODEL,
  openai: "gpt-5",
  google: "gemini-2.5-pro",
};

/**
 * The judge model a run uses for a given provider. A run's provider is derived from its chosen
 * reflect/target model (a run is single-provider), so the judge runs on the same provider's key
 * as the rest of the run (#204). Anthropic keeps its ANTHROPIC_MODEL env override (existing
 * behavior); the other providers have no env override.
 */
export function defaultJudgeModelForProvider(provider: LlmProvider): string {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL;
  }
  return DEFAULT_JUDGE_BY_PROVIDER[provider];
}

/** The most-capable default reflect model for a provider — the fallback when a run's stored
 *  reflect_model isn't a model that provider serves. */
export function defaultReflectModelForProvider(provider: LlmProvider): string {
  return DEFAULT_REFLECT_BY_PROVIDER[provider];
}
