// App-side reflection-model registry for the Optimization start wizard. The reflection model
// rewrites a Module's prompt each iteration (D7); it's selectable per run.
//
// This mirrors the worker's ANTHROPIC_MODELS (worker/src/providers/models.ts). The app and the
// worker are separate TypeScript projects (the app's tsconfig excludes worker/), so they can't
// share a module yet — extracting a shared package is tracked as #93. Until then this is the
// app's single source for the reflectModel options: one const list → derived type, per the
// single-source-enums convention.
export const REFLECT_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced (default)" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest" },
] as const;

export type ReflectModelId = (typeof REFLECT_MODELS)[number]["id"];

export const DEFAULT_REFLECT_MODEL: ReflectModelId = "claude-sonnet-4-6";

// Simple Mode (ADR-0015) reuses the reflect_model column for its generation model but defaults
// it to Haiku, not Sonnet: rewrites are mechanical operator applications and Simple runs the
// model far more often than GEPA's one reflection per iteration, so fast/cheap is the fit.
export const DEFAULT_SIMPLE_REFLECT_MODEL: ReflectModelId = "claude-haiku-4-5-20251001";

// App-side target-model registry for a Managed Agent (#293): the Anthropic model the
// "Paste a prompt" System runs the optimized prompt on. Mirrors the worker's ANTHROPIC_MODELS
// (same #93 caveat as above). Haiku leads — the managed path's headline is fast + cheap — and
// is the default; the order here is the dropdown order.
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
