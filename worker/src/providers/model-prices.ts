// Worker copy of the managed-token price table (#185, ADR-0008 Meter 2). Must
// stay identical to the app's src/lib/llm/model-prices.ts MODEL_PRICES — the
// worker is a separate project pending the shared-package extraction (#93). The
// app's parity test imports this file and asserts the two tables are deep-equal,
// so a drift fails CI. No imports here on purpose: the app test runner imports
// this file directly (same convention as provider-list.ts).
//
// Prices are provider LIST prices in USD per token. They are SNAPSHOTTED into
// each accrual row at call time (managed_spend_ledger.input_unit_usd /
// output_unit_usd), so repricing this table never rewrites billed history.
//
// typicalInputTokens / typicalOutputTokens describe a typical JUDGE call — the
// pre-run dollar estimate (managed-spend-estimate.ts) multiplies them by the
// number of judge calls (rows × criteria). They are an estimate input only; the
// actual charge is always metered from real token counts.

export interface ModelPrice {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  typicalInputTokens: number;
  typicalOutputTokens: number;
}

// Keyed provider → model. Provider-agnostic by construction (ADR-0008): every
// runtime-ready provider/model carries a managed LIST price so a managed call can
// price it; OpenAI, Google, and Mistral are now runtime-wired (#204) and priced here. A
// model absent from the table still fails closed (priceForModel returns null — an
// unpriced model can never run on a managed key).
export const MODEL_PRICES: Record<string, Record<string, ModelPrice>> = {
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
 * The unit prices for a provider/model, or null if the model is not in the
 * table. A null result MUST fail closed for managed calls — ADR-0008's
 * "no unpriced managed call can execute". BYO calls are unaffected (the customer
 * pays their own provider directly; we never meter them).
 */
export function priceForModel(provider: string, model: string): ModelPrice | null {
  return MODEL_PRICES[provider]?.[model] ?? null;
}
