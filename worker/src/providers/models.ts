// Single source for the Anthropic models the worker uses. One const list, the type and the
// defaults are derived from it — no duplicated unions (the project's enum convention). The
// judge stays cheap/high-volume (Haiku); reflection runs on Sonnet (D7), overridable per
// Optimization Run via optimization_runs.reflect_model.

import { type LlmProvider } from "./provider-list.js";

export const ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

export function isAnthropicModel(value: string): value is AnthropicModel {
  return (ANTHROPIC_MODELS as readonly string[]).includes(value);
}

/**
 * The provider that serves a given model (#184). Key resolution derives the
 * provider from the model a run will actually call, rather than hardcoding one
 * at the call site. Only Anthropic models are wired today; when a second
 * provider's models land they join this mapping (alongside LLM_PROVIDERS and a
 * runtime client). An unrecognized model resolves to the default provider — the
 * judge/reflect defaults are Anthropic models — so key resolution still finds a
 * key rather than failing outright.
 */
export function providerForModel(model: string): LlmProvider {
  if (isAnthropicModel(model)) return "anthropic";
  return "anthropic";
}

export const DEFAULT_JUDGE_MODEL: AnthropicModel = "claude-haiku-4-5-20251001";
export const DEFAULT_REFLECT_MODEL: AnthropicModel = "claude-sonnet-4-6";
