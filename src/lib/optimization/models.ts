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
