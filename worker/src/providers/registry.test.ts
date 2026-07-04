import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  RUNTIME_READY_PROVIDERS,
  MANAGED_KEY_ENV,
  PROVIDER_KEY_PATTERNS,
  isLlmProvider,
  isRuntimeReady,
  validateProviderKeyFormat,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  MISTRAL_MODELS,
  MODEL_PROVIDER,
  providerForModel,
  isKnownModel,
  isAnthropicModel,
  isOpenAIModel,
  isGoogleModel,
  isMistralModel,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_JUDGE_BY_PROVIDER,
  DEFAULT_REFLECT_BY_PROVIDER,
  defaultJudgeModelForProvider,
  defaultReflectModelForProvider,
  MODEL_PRICES,
  priceForModel,
  isPricedModel,
} from "./registry.js";

// Baseline's single source for "provider X at price Y with default judge model Z" (#379). The
// app imports this exact module (via thin shims in src/lib/llm/*) rather than keeping its own
// copy, so there is nothing left to drift — these are ordinary unit tests of the one definition,
// not a cross-package parity guard.

const CANONICAL = ["anthropic", "openai", "google", "mistral"];

describe("provider list (#184)", () => {
  it("ships the canonical provider set", () => {
    expect([...LLM_PROVIDERS]).toEqual(CANONICAL);
  });

  it("has a display label for every provider", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_LABELS[provider]).toBeTruthy();
    }
  });

  it("marks anthropic, openai, google, and mistral runtime-ready (#204)", () => {
    expect([...RUNTIME_READY_PROVIDERS]).toEqual(CANONICAL);
    for (const provider of LLM_PROVIDERS) {
      expect(isRuntimeReady(provider)).toBe(true);
    }
  });

  it("has a managed-key env var for every provider", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(MANAGED_KEY_ENV[provider]).toBeTruthy();
    }
    expect(Object.keys(MANAGED_KEY_ENV).sort()).toEqual([...LLM_PROVIDERS].sort());
  });

  it("validates membership", () => {
    expect(isLlmProvider("anthropic")).toBe(true);
    expect(isLlmProvider("bogus")).toBe(false);
    expect(isLlmProvider(123)).toBe(false);
  });
});

describe("BYO key-format patterns (#342)", () => {
  it("has a pattern for every provider", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_KEY_PATTERNS[provider]).toBeTruthy();
    }
  });

  it("accepts a well-formed key per provider", () => {
    expect(validateProviderKeyFormat("anthropic", "sk-ant-" + "x".repeat(20))).toBeNull();
    expect(validateProviderKeyFormat("openai", "sk-" + "x".repeat(20))).toBeNull();
    expect(validateProviderKeyFormat("google", "AIza" + "x".repeat(20))).toBeNull();
    expect(validateProviderKeyFormat("mistral", "AbCdEf1234567890XyZ")).toBeNull();
  });

  it("rejects a too-short or wrong-prefix key", () => {
    expect(validateProviderKeyFormat("anthropic", "sk-ant-short")).toBeTruthy();
    expect(validateProviderKeyFormat("openai", "AIza" + "x".repeat(20))).toBeTruthy();
  });
});

describe("model registry (#204)", () => {
  it("maps every listed model to its provider", () => {
    for (const m of ANTHROPIC_MODELS) expect(MODEL_PROVIDER[m]).toBe("anthropic");
    for (const m of OPENAI_MODELS) expect(MODEL_PROVIDER[m]).toBe("openai");
    for (const m of GOOGLE_MODELS) expect(MODEL_PROVIDER[m]).toBe("google");
    for (const m of MISTRAL_MODELS) expect(MODEL_PROVIDER[m]).toBe("mistral");
  });

  it("providerForModel resolves a known model and falls back to anthropic for an unknown one", () => {
    expect(providerForModel("gpt-5")).toBe("openai");
    expect(providerForModel("totally-unknown-model")).toBe("anthropic");
  });

  it("isKnownModel is true only for registered models", () => {
    expect(isKnownModel("claude-sonnet-4-6")).toBe(true);
    expect(isKnownModel("nonexistent")).toBe(false);
  });

  it("per-provider membership guards agree with MODEL_PROVIDER", () => {
    expect(isAnthropicModel("claude-opus-4-8")).toBe(true);
    expect(isAnthropicModel("gpt-5")).toBe(false);
    expect(isOpenAIModel("gpt-5-mini")).toBe(true);
    expect(isGoogleModel("gemini-2.5-flash")).toBe(true);
    expect(isMistralModel("mistral-large-latest")).toBe(true);
  });

  it("has a judge and reflect default for every provider, and prices them", () => {
    for (const provider of LLM_PROVIDERS) {
      const judge = DEFAULT_JUDGE_BY_PROVIDER[provider];
      const reflect = DEFAULT_REFLECT_BY_PROVIDER[provider];
      expect(judge).toBeTruthy();
      expect(reflect).toBeTruthy();
      expect(isPricedModel(provider, judge)).toBe(true);
      expect(isPricedModel(provider, reflect)).toBe(true);
    }
  });

  it("defaultJudgeModelForProvider honors the ANTHROPIC_MODEL env override; others use the plain default", () => {
    expect(defaultJudgeModelForProvider("anthropic")).toBe(DEFAULT_JUDGE_MODEL);
    for (const provider of ["openai", "google", "mistral"] as const) {
      expect(defaultJudgeModelForProvider(provider)).toBe(DEFAULT_JUDGE_BY_PROVIDER[provider]);
    }
  });

  it("defaultReflectModelForProvider matches DEFAULT_REFLECT_BY_PROVIDER", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(defaultReflectModelForProvider(provider)).toBe(DEFAULT_REFLECT_BY_PROVIDER[provider]);
    }
    expect(defaultReflectModelForProvider("anthropic")).toBe(DEFAULT_REFLECT_MODEL);
  });
});

describe("MODEL_PRICES (#185, ADR-0008)", () => {
  it("prices every model in the registry, with positive rates and token assumptions", () => {
    for (const [provider, models] of Object.entries(MODEL_PRICES) as [
      keyof typeof MODEL_PRICES,
      Record<string, { inputUsdPerToken: number; outputUsdPerToken: number; typicalInputTokens: number; typicalOutputTokens: number }>,
    ][]) {
      for (const [model, price] of Object.entries(models)) {
        expect(priceForModel(provider, model)).toEqual(price);
        expect(price.inputUsdPerToken).toBeGreaterThan(0);
        expect(price.outputUsdPerToken).toBeGreaterThan(0);
        expect(price.typicalInputTokens).toBeGreaterThan(0);
        expect(price.typicalOutputTokens).toBeGreaterThan(0);
      }
    }
  });

  it("returns null for an unpriced model (fail-closed signal, ADR-0008)", () => {
    expect(priceForModel("anthropic", "claude-nonexistent")).toBeNull();
    expect(priceForModel("openai", "gpt-nonexistent")).toBeNull();
    expect(isPricedModel("anthropic", "claude-nonexistent")).toBe(false);
  });
});
