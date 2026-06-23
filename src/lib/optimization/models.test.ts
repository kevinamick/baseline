import { describe, it, expect } from "vitest";
import {
  REFLECT_MODELS,
  TARGET_MODELS,
  providerForReflectModel,
  reflectModelGroups,
  defaultReflectModelFor,
  PROVIDER_DEFAULT_REFLECT_MODEL,
  PROVIDER_DEFAULT_SIMPLE_MODEL,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_SIMPLE_REFLECT_MODEL,
} from "./models";
// The worker owns the canonical model→provider registry (separate project, #93). This test
// imports it directly and pins each app reflect-model option to it, so a drift in either file
// fails CI — the same mechanical-parity guard used for LLM_PROVIDERS and MODEL_PRICES (#204).
import {
  MODEL_PROVIDER,
  providerForModel as workerProviderForModel,
  defaultJudgeModelForProvider,
  defaultReflectModelForProvider,
} from "../../../worker/src/providers/models";
import type { LlmProvider } from "@/lib/llm/providers";

describe("reflect-model registry parity with the worker (#204)", () => {
  it("maps every app reflect model to the worker's provider for it", () => {
    for (const m of REFLECT_MODELS) {
      expect(m.provider).toBe(MODEL_PROVIDER[m.id]);
      expect(providerForReflectModel(m.id)).toBe(workerProviderForModel(m.id));
    }
  });

  it("covers all three providers now that OpenAI and Google are runtime-ready", () => {
    const providers = new Set(REFLECT_MODELS.map((m) => m.provider));
    expect(providers).toEqual(new Set<LlmProvider>(["anthropic", "openai", "google"]));
  });

  it("pins per-provider defaults to the worker's run-time defaults", () => {
    for (const p of ["anthropic", "openai", "google"] as const) {
      // Reflective default = worker's reflect default; Simple default = worker's judge (fast) default.
      expect(PROVIDER_DEFAULT_REFLECT_MODEL[p]).toBe(defaultReflectModelForProvider(p));
      // Anthropic's judge default honors the ANTHROPIC_MODEL env override at run time; in tests
      // (env unset) it equals Haiku, the Simple default.
      expect(PROVIDER_DEFAULT_SIMPLE_MODEL[p]).toBe(defaultJudgeModelForProvider(p));
    }
  });

  it("ships the Anthropic defaults as the global defaults", () => {
    expect(DEFAULT_REFLECT_MODEL).toBe(PROVIDER_DEFAULT_REFLECT_MODEL.anthropic);
    expect(DEFAULT_SIMPLE_REFLECT_MODEL).toBe(PROVIDER_DEFAULT_SIMPLE_MODEL.anthropic);
  });

  it("keeps Managed Agent target models Anthropic-only for now (#204)", () => {
    for (const m of TARGET_MODELS) expect(MODEL_PROVIDER[m.id]).toBe("anthropic");
  });
});

describe("reflectModelGroups + defaultReflectModelFor (#204)", () => {
  it("only groups providers the Team can use, in LLM_PROVIDERS order", () => {
    const groups = reflectModelGroups(["google", "anthropic"]);
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "google"]);
    expect(groups.every((g) => g.models.length > 0)).toBe(true);
  });

  it("omits providers the Team can't use", () => {
    const groups = reflectModelGroups(["openai"]);
    expect(groups.map((g) => g.provider)).toEqual(["openai"]);
    expect(groups[0].models.every((m) => m.provider === "openai")).toBe(true);
  });

  it("keeps the preferred model when its provider is usable", () => {
    expect(
      defaultReflectModelFor(["anthropic", "openai"], DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL),
    ).toBe(DEFAULT_REFLECT_MODEL);
  });

  it("falls back to the first usable provider's default when the preferred isn't usable", () => {
    expect(
      defaultReflectModelFor(["openai"], DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL),
    ).toBe(PROVIDER_DEFAULT_REFLECT_MODEL.openai);
  });

  it("returns null when no provider is usable", () => {
    expect(defaultReflectModelFor([], DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL)).toBeNull();
  });
});
