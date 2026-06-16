import { describe, it, expect } from "vitest";
import {
  MODEL_PRICES,
  priceForModel,
  isPricedModel,
  ESTIMATE_JUDGE_MODEL,
  ESTIMATE_JUDGE_PROVIDER,
  ESTIMATE_REFLECT_MODEL,
} from "@/lib/llm/model-prices";
// The worker keeps its own copy of the price table (separate project, #93). This
// test imports it directly and asserts deep equality, so a drift in either file
// fails CI — the same mechanical-parity guard used for LLM_PROVIDERS (#184).
import { MODEL_PRICES as WORKER_PRICES } from "../../../../worker/src/providers/model-prices";
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
} from "../../../../worker/src/providers/models";

describe("MODEL_PRICES (#185)", () => {
  it("stays identical to the worker's copy (mechanical parity)", () => {
    expect(MODEL_PRICES).toEqual(WORKER_PRICES);
  });

  it("prices every model the worker reaches for by default", () => {
    // A managed call on an unpriced model fails closed (ADR-0008). The worker's
    // own defaults must therefore always be priced, or managed runs can't start.
    expect(isPricedModel("anthropic", DEFAULT_JUDGE_MODEL)).toBe(true);
    expect(isPricedModel("anthropic", DEFAULT_REFLECT_MODEL)).toBe(true);
  });

  it("pins the estimate's judge model to the worker's default", () => {
    // The app's pre-run estimate prices ESTIMATE_JUDGE_MODEL; the worker runs the
    // judge on DEFAULT_JUDGE_MODEL. If they drift, the estimate prices a different
    // model than the run uses.
    expect(ESTIMATE_JUDGE_PROVIDER).toBe("anthropic");
    expect(ESTIMATE_JUDGE_MODEL).toBe(DEFAULT_JUDGE_MODEL);
    expect(ESTIMATE_REFLECT_MODEL).toBe(DEFAULT_REFLECT_MODEL);
    expect(isPricedModel(ESTIMATE_JUDGE_PROVIDER, ESTIMATE_JUDGE_MODEL)).toBe(true);
    expect(isPricedModel(ESTIMATE_JUDGE_PROVIDER, ESTIMATE_REFLECT_MODEL)).toBe(true);
  });

  it("returns null for an unpriced model (fail-closed signal)", () => {
    expect(priceForModel("anthropic", "claude-nonexistent")).toBeNull();
    // openai/google store keys but aren't runtime-priced yet (#204).
    expect(priceForModel("openai", "gpt-5")).toBeNull();
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
