import { describe, it, expect } from "vitest";
import { createProvider, createProviderForModel } from "./factory.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GoogleProvider } from "./google.js";
import { MistralProvider } from "./mistral.js";
import {
  MODEL_PROVIDER,
  providerForModel,
  isKnownModel,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  MISTRAL_MODELS,
  defaultJudgeModelForProvider,
  defaultReflectModelForProvider,
} from "./models.js";

describe("provider→client factory (#204)", () => {
  it("picks the concrete client for each provider", () => {
    expect(createProvider("anthropic", { apiKey: "k" })).toBeInstanceOf(AnthropicProvider);
    expect(createProvider("openai", { apiKey: "k" })).toBeInstanceOf(OpenAIProvider);
    expect(createProvider("google", { apiKey: "k" })).toBeInstanceOf(GoogleProvider);
    expect(createProvider("mistral", { apiKey: "k" })).toBeInstanceOf(MistralProvider);
  });

  it("routes a model to its provider's client", () => {
    expect(createProviderForModel("claude-sonnet-4-6", { apiKey: "k" })).toBeInstanceOf(
      AnthropicProvider,
    );
    expect(createProviderForModel("gpt-5", { apiKey: "k" })).toBeInstanceOf(OpenAIProvider);
    expect(createProviderForModel("gemini-2.5-pro", { apiKey: "k" })).toBeInstanceOf(GoogleProvider);
    expect(createProviderForModel("mistral-large-latest", { apiKey: "k" })).toBeInstanceOf(
      MistralProvider,
    );
  });

  it("falls back to Anthropic for an unknown model (fail-safe)", () => {
    expect(createProviderForModel("totally-made-up", { apiKey: "k" })).toBeInstanceOf(
      AnthropicProvider,
    );
  });
});

describe("model→provider registry (#204)", () => {
  it("maps every registered model to its true provider", () => {
    for (const m of ANTHROPIC_MODELS) expect(providerForModel(m)).toBe("anthropic");
    for (const m of OPENAI_MODELS) expect(providerForModel(m)).toBe("openai");
    for (const m of GOOGLE_MODELS) expect(providerForModel(m)).toBe("google");
    for (const m of MISTRAL_MODELS) expect(providerForModel(m)).toBe("mistral");
  });

  it("no longer defaults known non-Anthropic models to Anthropic", () => {
    expect(providerForModel("gpt-5")).not.toBe("anthropic");
    expect(providerForModel("gemini-2.5-pro")).not.toBe("anthropic");
  });

  it("recognizes registered models and rejects unknown ones", () => {
    expect(isKnownModel("gpt-5-mini")).toBe(true);
    expect(isKnownModel("claude-haiku-4-5-20251001")).toBe(true);
    expect(isKnownModel("nope")).toBe(false);
  });

  it("every model in MODEL_PROVIDER is unique to one provider", () => {
    const ids = [...ANTHROPIC_MODELS, ...OPENAI_MODELS, ...GOOGLE_MODELS, ...MISTRAL_MODELS];
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(MODEL_PROVIDER).sort()).toEqual([...ids].sort());
  });

  it("each provider's judge/reflect defaults belong to that provider", () => {
    for (const p of ["anthropic", "openai", "google", "mistral"] as const) {
      expect(providerForModel(defaultJudgeModelForProvider(p))).toBe(p);
      expect(providerForModel(defaultReflectModelForProvider(p))).toBe(p);
    }
  });
});
