/**
 * Managed-token price table (#185, ADR-0008 Meter 2): provider LIST prices in
 * USD per token, plus a typical-call token assumption used for the pre-run
 * dollar estimate. One source the app reads from; the worker keeps its own copy
 * at worker/src/providers/model-prices.ts (separate project, #93) and the parity
 * test in __tests__/model-prices.test.ts asserts the two are deep-equal — a drift
 * in either file fails CI.
 *
 * Prices are SNAPSHOTTED into each accrual row at call time, so repricing this
 * table never rewrites billed history (the billing-transparency principle).
 *
 * typicalInputTokens / typicalOutputTokens describe a typical JUDGE call: the
 * estimate multiplies them by the judge-call count (rows × criteria). They drive
 * the *estimate* only — the actual charge is metered from real token counts.
 */
import { LLM_PROVIDERS, type LlmProvider } from "@/lib/llm/providers";

export interface ModelPrice {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  typicalInputTokens: number;
  typicalOutputTokens: number;
}

// Provider-agnostic by construction: every runtime-ready provider/model carries a
// managed LIST price. OpenAI and Google are now runtime-wired (#204) and priced
// here in lockstep with the worker's copy (the parity test asserts deep equality).
// A model absent from the table still fails closed via priceForModel null.
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
  },
};

/**
 * Unit prices for a provider/model, or null if absent. A null MUST fail closed
 * for managed calls (ADR-0008: no unpriced managed call can execute).
 */
export function priceForModel(
  provider: LlmProvider,
  model: string,
): ModelPrice | null {
  return MODEL_PRICES[provider]?.[model] ?? null;
}

/** True when the provider/model has a managed price (can run on a managed key). */
export function isPricedModel(provider: LlmProvider, model: string): boolean {
  return priceForModel(provider, model) != null;
}

/**
 * The judge model/provider the pre-run estimate prices against. The worker runs
 * the judge on `ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL`; the estimate is
 * approximate, so it prices the default. Pinned to the worker's DEFAULT_JUDGE_MODEL
 * by the parity test, so the estimate and the worker never price different models.
 */
export const ESTIMATE_JUDGE_PROVIDER: LlmProvider = "anthropic";
export const ESTIMATE_JUDGE_MODEL = "claude-haiku-4-5-20251001";

/**
 * The default reflect model the optimization estimate prices against (a run may
 * override it via optimization_runs.reflect_model). Pinned to the worker's
 * DEFAULT_REFLECT_MODEL by the parity test.
 */
export const ESTIMATE_REFLECT_MODEL = "claude-sonnet-4-6";

// Touch LLM_PROVIDERS so the table's key set is pinned to the provider list —
// adding a provider to LLM_PROVIDERS without a MODEL_PRICES entry is a type error.
void (LLM_PROVIDERS satisfies readonly LlmProvider[]);
