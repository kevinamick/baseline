// Single source for the Anthropic models the worker uses. One const list, the type and the
// defaults are derived from it — no duplicated unions (the project's enum convention). The
// judge stays cheap/high-volume (Haiku); reflection runs on Sonnet (D7), overridable per
// Optimization Run via optimization_runs.reflect_model.

export const ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

export function isAnthropicModel(value: string): value is AnthropicModel {
  return (ANTHROPIC_MODELS as readonly string[]).includes(value);
}

export const DEFAULT_JUDGE_MODEL: AnthropicModel = "claude-haiku-4-5-20251001";
export const DEFAULT_REFLECT_MODEL: AnthropicModel = "claude-sonnet-4-6";
