// THE single source for "Baseline supports provider X at price Y with default judge/reflect
// model Z" (#379, first tracer bullet of the shared-package extraction #93). Previously this fact
// was spread across ~12 files mirrored byte-for-byte across the app and worker (two separate
// TypeScript projects, no shared workspace) and pinned together only by cross-package parity
// tests. This file collapses it to one definition: a set of per-provider Records (ids, labels,
// runtime-readiness, key-format patterns, model lists, prices, judge/reflect defaults, managed-key
// env var names), all keyed by `LlmProvider` so `Record<LlmProvider, …>` makes a new provider's
// row fail typecheck everywhere until every field is filled in (the project's single-source-enums
// convention, applied at package scale).
//
// Both the worker (Node, NodeNext-style `.js` specifiers elsewhere in this package) and the Next
// app (Turbopack) import this exact file. Turbopack does NOT resolve a `.js` specifier to its
// `.ts` source and doesn't support `experimental.extensionAlias` (see the dataset-adapter seam,
// worker/src/adapters/*, and the root AGENTS.md "Dataset Connections" section) — this file has
// deliberately ZERO relative imports, so that sharp edge never applies to it. Keep it that way:
// if this module ever needs to import another worker file, that import must be extensionless.
//
// App-facing shims re-export from here rather than every app call site reaching across the
// package boundary directly: src/lib/llm/providers.ts, src/lib/llm/model-prices.ts,
// src/lib/llm/keys.ts (PROVIDER_KEY_PATTERNS), src/lib/optimization/models.ts (the reflect/target
// model UI lists derive their provider/model facts from here; the UI labels are presentation-only
// and stay hand-written).
//
// ADDING A PROVIDER: (1) add its id to LLM_PROVIDERS and fill in every Record below (label,
// managed-key env var, key-format pattern, model list, prices, judge/reflect defaults) — TS will
// refuse to compile until every Record has the new key; (2) write its `ProviderAdapter` (or a full
// client, for a non-fetch SDK provider like Anthropic) and wire it into
// worker/src/providers/factory.ts; (3) add a migration widening the `provider_keys.provider` CHECK
// constraint. Nothing else needs to change — every UI label, key-format validator, price lookup,
// and default-model mapping derives from this file.

export const LLM_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Display names for the settings UI. */
export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
};

/**
 * Providers with a runtime client wired in the worker today. Storage works for every provider in
 * LLM_PROVIDERS; only a runtime-ready provider's key is actually used at run time. A provider not
 * listed here saves fine but renders a "Coming soon" badge in the UI — keys aren't silently
 * ignored (billing-transparency principle). Anthropic, OpenAI, Google, and Mistral are all
 * runtime-wired (#204).
 */
export const RUNTIME_READY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "mistral",
] as const satisfies readonly LlmProvider[];

export function isRuntimeReady(provider: LlmProvider): boolean {
  return (RUNTIME_READY_PROVIDERS as readonly LlmProvider[]).includes(provider);
}

// Managed platform key per provider — the paid-plan fallback when a Team has no BYO key. One env
// var each; no single hardcoded ANTHROPIC_API_KEY assumption. A provider with no managed key
// configured (or not paid-eligible) resolves to "none" and the run fails closed.
export const MANAGED_KEY_ENV: Record<LlmProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/**
 * BYO key-format validation (#342): each provider issues keys with a recognizable prefix and
 * minimum length. Rejecting values that can't possibly be real keys prevents a fake/garbage key
 * from being stored and silently used instead of the managed fallback. Deliberately conservative
 * (prefix + minimum length) so legitimate key formats (including newer variants) aren't rejected,
 * while obvious fakes are.
 */
export interface ProviderKeyPattern {
  pattern: RegExp;
  minLength: number;
  label: string;
  hint: string;
}

export const PROVIDER_KEY_PATTERNS: Record<LlmProvider, ProviderKeyPattern> = {
  anthropic: { pattern: /^sk-ant-/, minLength: 20, label: "Anthropic", hint: 'start with "sk-ant-"' },
  openai: { pattern: /^sk-/, minLength: 20, label: "OpenAI", hint: 'start with "sk-"' },
  google: { pattern: /^AIza/, minLength: 20, label: "Google", hint: 'start with "AIza"' },
  mistral: {
    pattern: /^[A-Za-z0-9]{16,}$/,
    minLength: 16,
    label: "Mistral",
    hint: "be a long alphanumeric string",
  },
};

/** Validate a BYO provider key's format. Returns an error message, or null when it passes. */
export function validateProviderKeyFormat(provider: LlmProvider, key: string): string | null {
  const spec = PROVIDER_KEY_PATTERNS[provider];
  if (key.length < spec.minLength) {
    return `That ${spec.label} API key looks too short. Check that you copied the full key.`;
  }
  if (!spec.pattern.test(key)) {
    return `That doesn't look like a valid ${spec.label} API key — ${spec.label} keys ${spec.hint}. Check that you copied the right key.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Models: the LLM models the worker can call, and the model→provider mapping key resolution and
// metering derive from. One const list per provider; the types, the per-provider membership
// guards, and the unified MODEL_PROVIDER map are all derived from them — no duplicated unions.
// The judge stays cheap/high-volume (a provider's fast model); reflection runs on a provider's
// most-capable model (D7), overridable per Optimization Run via optimization_runs.reflect_model.
// ---------------------------------------------------------------------------------------------

export const ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5",
] as const;

export const OPENAI_MODELS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

export const GOOGLE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
] as const;

export const MISTRAL_MODELS = ["mistral-large-latest", "mistral-small-latest"] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export type GoogleModel = (typeof GOOGLE_MODELS)[number];
export type MistralModel = (typeof MISTRAL_MODELS)[number];

/** Every model in the registry, across every provider. */
export type AnyModel = AnthropicModel | OpenAIModel | GoogleModel | MistralModel;

export function isAnthropicModel(value: string): value is AnthropicModel {
  return (ANTHROPIC_MODELS as readonly string[]).includes(value);
}

export function isOpenAIModel(value: string): value is OpenAIModel {
  return (OPENAI_MODELS as readonly string[]).includes(value);
}

export function isGoogleModel(value: string): value is GoogleModel {
  return (GOOGLE_MODELS as readonly string[]).includes(value);
}

export function isMistralModel(value: string): value is MistralModel {
  return (MISTRAL_MODELS as readonly string[]).includes(value);
}

// The model→provider map, built once from the per-provider lists. Single source: every lookup
// (key resolution, metering, the runtime client factory, the app's reflect-model wizard) derives
// from it, so a model can only ever map to one provider and adding a model is a one-line list edit.
export const MODEL_PROVIDER: Record<string, LlmProvider> = {
  ...Object.fromEntries(ANTHROPIC_MODELS.map((m) => [m, "anthropic" as const])),
  ...Object.fromEntries(OPENAI_MODELS.map((m) => [m, "openai" as const])),
  ...Object.fromEntries(GOOGLE_MODELS.map((m) => [m, "google" as const])),
  ...Object.fromEntries(MISTRAL_MODELS.map((m) => [m, "mistral" as const])),
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

// Pure data (no env lookups) — safe to import from anywhere, including a client bundle. The
// Anthropic ANTHROPIC_MODEL env override lives only in defaultJudgeModelForProvider() below,
// which is Node-only (worker call sites, and app server actions/route handlers — never a
// client component).
export const DEFAULT_JUDGE_BY_PROVIDER: Record<LlmProvider, AnyModel> = {
  anthropic: DEFAULT_JUDGE_MODEL,
  openai: "gpt-5-mini",
  google: "gemini-2.5-flash",
  mistral: "mistral-small-latest",
};

export const DEFAULT_REFLECT_BY_PROVIDER: Record<LlmProvider, AnyModel> = {
  anthropic: DEFAULT_REFLECT_MODEL,
  openai: "gpt-5",
  google: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
};

/**
 * The judge model a run uses for a given provider. A run's provider is derived from its chosen
 * reflect/target model (a run is single-provider), so the judge runs on the same provider's key
 * as the rest of the run (#204). Anthropic keeps its ANTHROPIC_MODEL env override (existing
 * behavior); the other providers have no env override. Node-only (reads process.env) — do not
 * call from code reachable by a client bundle; use DEFAULT_JUDGE_BY_PROVIDER there instead.
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

// ---------------------------------------------------------------------------------------------
// Prices: the managed-token price table (#185, ADR-0008 Meter 2). Prices are provider LIST prices
// in USD per token. They are SNAPSHOTTED into each accrual row at call time
// (managed_spend_ledger.input_unit_usd / output_unit_usd), so repricing this table never rewrites
// billed history.
//
// typicalInputTokens / typicalOutputTokens describe a typical JUDGE call — the pre-run dollar
// estimate (managed-spend-estimate.ts) multiplies them by the number of judge calls (rows ×
// criteria). They are an estimate input only; the actual charge is always metered from real token
// counts.
// ---------------------------------------------------------------------------------------------

export interface ModelPrice {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  typicalInputTokens: number;
  typicalOutputTokens: number;
}

// Provider-agnostic by construction (ADR-0008): every runtime-ready provider/model carries a
// managed LIST price so a managed call can price it. A model absent from the table still fails
// closed (priceForModel returns null — an unpriced model can never run on a managed key).
export const MODEL_PRICES: Record<LlmProvider, Record<string, ModelPrice>> = {
  anthropic: {
    "claude-haiku-4-5-20251001": {
      inputUsdPerToken: 0.000001, // $1.00 / MTok
      outputUsdPerToken: 0.000005, // $5.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
    "claude-sonnet-4-6": {
      inputUsdPerToken: 0.000003, // $3.00 / MTok
      outputUsdPerToken: 0.000015, // $15.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    "claude-opus-4-8": {
      inputUsdPerToken: 0.000015, // $15.00 / MTok
      outputUsdPerToken: 0.000075, // $75.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    // #495 model intake. Verified https://platform.claude.com/docs/en/about-claude/pricing
    // (fetched 2026-07-13). Introductory pricing in effect through 2026-08-31: $2.00 / MTok input,
    // $10.00 / MTok output. Standard pricing takes effect 2026-09-01: $3.00 / MTok input,
    // $15.00 / MTok output — revisit this row before then so managed calls aren't underpriced.
    "claude-sonnet-5": {
      inputUsdPerToken: 0.000002, // $2.00 / MTok (introductory, through 2026-08-31)
      outputUsdPerToken: 0.00001, // $10.00 / MTok (introductory, through 2026-08-31)
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    // #495 model intake. Verified https://platform.claude.com/docs/en/about-claude/pricing
    // (fetched 2026-07-13): $10.00 / MTok input, $50.00 / MTok output — Anthropic's new
    // top-of-line model, priced above Opus 4.8.
    "claude-fable-5": {
      inputUsdPerToken: 0.00001, // $10.00 / MTok
      outputUsdPerToken: 0.00005, // $50.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
  },
  openai: {
    "gpt-5": {
      inputUsdPerToken: 0.00000125, // $1.25 / MTok
      outputUsdPerToken: 0.00001, // $10.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    "gpt-5-mini": {
      inputUsdPerToken: 0.00000025, // $0.25 / MTok
      outputUsdPerToken: 0.000002, // $2.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
    // #495 model intake. Verified https://developers.openai.com/api/docs/pricing (fetched
    // 2026-07-13): $2.50 / MTok input, $15.00 / MTok output.
    "gpt-5.4": {
      inputUsdPerToken: 0.0000025, // $2.50 / MTok
      outputUsdPerToken: 0.000015, // $15.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    // #495 model intake. Verified https://developers.openai.com/api/docs/pricing (fetched
    // 2026-07-13): $5.00 / MTok input, $30.00 / MTok output.
    "gpt-5.5": {
      inputUsdPerToken: 0.000005, // $5.00 / MTok
      outputUsdPerToken: 0.00003, // $30.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    // #495 model intake. GPT-5.6's three durable capability tiers (Luna/Terra/Sol), verified
    // https://developers.openai.com/api/docs/pricing and https://openai.com/index/gpt-5-6/
    // (fetched 2026-07-13). Luna is the fast/affordable tier — priced and treated like the
    // provider's fast model, hence typicalOutputTokens 300 (matches gpt-5-mini's convention).
    "gpt-5.6-luna": {
      inputUsdPerToken: 0.000001, // $1.00 / MTok
      outputUsdPerToken: 0.000006, // $6.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
    "gpt-5.6-terra": {
      inputUsdPerToken: 0.0000025, // $2.50 / MTok
      outputUsdPerToken: 0.000015, // $15.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    "gpt-5.6-sol": {
      inputUsdPerToken: 0.000005, // $5.00 / MTok
      outputUsdPerToken: 0.00003, // $30.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
  },
  google: {
    "gemini-2.5-pro": {
      inputUsdPerToken: 0.00000125, // $1.25 / MTok
      outputUsdPerToken: 0.00001, // $10.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    "gemini-2.5-flash": {
      inputUsdPerToken: 0.0000003, // $0.30 / MTok
      outputUsdPerToken: 0.0000025, // $2.50 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
    // #495 model intake. Verified https://ai.google.dev/gemini-api/docs/pricing (fetched
    // 2026-07-13): <=200k-token prompts price at $2.00 / MTok input, $12.00 / MTok output
    // (>200k tokens rises to $4.00 / $18.00 — this table prices the base <=200k tier, matching
    // the existing gemini-2.5-pro row's single-tier convention).
    "gemini-3.1-pro-preview": {
      inputUsdPerToken: 0.000002, // $2.00 / MTok (<=200k tokens)
      outputUsdPerToken: 0.000012, // $12.00 / MTok (<=200k tokens)
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    // #495 model intake. Verified https://ai.google.dev/gemini-api/docs/pricing (fetched
    // 2026-07-13): $0.50 / MTok input (text), $3.00 / MTok output.
    "gemini-3-flash-preview": {
      inputUsdPerToken: 0.0000005, // $0.50 / MTok
      outputUsdPerToken: 0.000003, // $3.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
    // #495 model intake. Verified https://ai.google.dev/gemini-api/docs/pricing (fetched
    // 2026-07-13): $1.50 / MTok input, $9.00 / MTok output.
    "gemini-3.5-flash": {
      inputUsdPerToken: 0.0000015, // $1.50 / MTok
      outputUsdPerToken: 0.000009, // $9.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
  },
  mistral: {
    "mistral-large-latest": {
      inputUsdPerToken: 0.000002, // $2.00 / MTok
      outputUsdPerToken: 0.000006, // $6.00 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 400,
    },
    "mistral-small-latest": {
      inputUsdPerToken: 0.0000002, // $0.20 / MTok
      outputUsdPerToken: 0.0000006, // $0.60 / MTok
      typicalInputTokens: 1500,
      typicalOutputTokens: 300,
    },
  },
};

/**
 * The unit prices for a provider/model, or null if the model is not in the table. A null result
 * MUST fail closed for managed calls — ADR-0008's "no unpriced managed call can execute". BYO
 * calls are unaffected (the customer pays their own provider directly; we never meter them).
 */
export function priceForModel(provider: LlmProvider, model: string): ModelPrice | null {
  return MODEL_PRICES[provider]?.[model] ?? null;
}

/** True when the provider/model has a managed price (can run on a managed key). */
export function isPricedModel(provider: LlmProvider, model: string): boolean {
  return priceForModel(provider, model) != null;
}
