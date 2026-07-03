import { describe, it, expect } from "vitest";
import {
  MODEL_PRICES,
  priceForModel,
  isPricedModel,
  ESTIMATE_JUDGE_MODEL,
  ESTIMATE_JUDGE_PROVIDER,
  ESTIMATE_REFLECT_MODEL,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
} from "@/lib/llm/model-prices";

// MODEL_PRICES comes straight from the shared registry (worker/src/providers/registry.ts, #379)
// via this module's re-export — there's nothing left to keep in lockstep with a separate parity
// test (the old worker/src/providers/model-prices.ts mirror is gone). ESTIMATE_JUDGE_MODEL /
// ESTIMATE_REFLECT_MODEL are direct aliases of the registry's DEFAULT_JUDGE_MODEL /
// DEFAULT_REFLECT_MODEL (same import), so they can't price a different model than the worker uses.
describe("MODEL_PRICES (#185)", () => {
  it("prices every model the worker reaches for by default", () => {
    // A managed call on an unpriced model fails closed (ADR-0008). The worker's
    // own defaults must therefore always be priced, or managed runs can't start.
    expect(isPricedModel("anthropic", DEFAULT_JUDGE_MODEL)).toBe(true);
    expect(isPricedModel("anthropic", DEFAULT_REFLECT_MODEL)).toBe(true);
  });

  it("pins the estimate's judge model to the registry's default", () => {
    expect(ESTIMATE_JUDGE_PROVIDER).toBe("anthropic");
    expect(ESTIMATE_JUDGE_MODEL).toBe(DEFAULT_JUDGE_MODEL);
    expect(ESTIMATE_REFLECT_MODEL).toBe(DEFAULT_REFLECT_MODEL);
    expect(isPricedModel(ESTIMATE_JUDGE_PROVIDER, ESTIMATE_JUDGE_MODEL)).toBe(true);
    expect(isPricedModel(ESTIMATE_JUDGE_PROVIDER, ESTIMATE_REFLECT_MODEL)).toBe(true);
  });

  it("returns null for an unpriced model (fail-closed signal)", () => {
    expect(priceForModel("anthropic", "claude-nonexistent")).toBeNull();
    // An unknown model on a runtime-ready provider still fails closed.
    expect(priceForModel("openai", "gpt-nonexistent")).toBeNull();
  });

  it("prices OpenAI, Google, and Mistral models now that they're runtime-ready (#204)", () => {
    expect(isPricedModel("openai", "gpt-5")).toBe(true);
    expect(isPricedModel("openai", "gpt-5-mini")).toBe(true);
    expect(isPricedModel("google", "gemini-2.5-pro")).toBe(true);
    expect(isPricedModel("google", "gemini-2.5-flash")).toBe(true);
    expect(isPricedModel("mistral", "mistral-large-latest")).toBe(true);
    expect(isPricedModel("mistral", "mistral-small-latest")).toBe(true);
  });

  it("every priced entry has positive rates and token assumptions", () => {
    for (const models of Object.values(MODEL_PRICES)) {
      for (const p of Object.values(models)) {
        expect(p.inputUsdPerToken).toBeGreaterThan(0);
        expect(p.outputUsdPerToken).toBeGreaterThan(0);
        expect(p.typicalInputTokens).toBeGreaterThan(0);
        expect(p.typicalOutputTokens).toBeGreaterThan(0);
      }
    }
  });
});
