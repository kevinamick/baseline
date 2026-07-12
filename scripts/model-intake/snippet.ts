/**
 * Paste-ready `worker/src/providers/registry.ts` snippet for a newly detected model (#484). Two
 * blocks: the model-list entry, and the MODEL_PRICES row (pre-filled from a LiteLLM suggestion
 * when one was found, otherwise explicit TODOs) — never auto-applied, always marked UNVERIFIED,
 * per the "human must approve the price" constraint (ADR-0008, see the issue's rationale).
 */
import type { LlmProvider } from "../../worker/src/providers/registry.ts";
import type { PriceSuggestion } from "./litellm-prices.ts";

const MODELS_CONST_NAME: Record<LlmProvider, string> = {
  anthropic: "ANTHROPIC_MODELS",
  openai: "OPENAI_MODELS",
  google: "GOOGLE_MODELS",
  mistral: "MISTRAL_MODELS",
};

export function buildRegistrySnippet(
  provider: LlmProvider,
  modelId: string,
  price: PriceSuggestion | null
): string {
  const listBlock = ["```ts", `"${modelId}",`, "```"].join("\n");

  const priceBlock = price
    ? [
        "```ts",
        `"${modelId}": {`,
        `  inputUsdPerToken: ${price.inputUsdPerToken}, // UNVERIFIED — confirm on ${provider}'s pricing page (LiteLLM: "${price.sourceKey}")`,
        `  outputUsdPerToken: ${price.outputUsdPerToken}, // UNVERIFIED — confirm on ${provider}'s pricing page`,
        `  typicalInputTokens: 1500, // TODO: tune once judge/reflect usage is observed`,
        `  typicalOutputTokens: 400, // TODO: tune once judge/reflect usage is observed`,
        `},`,
        "```",
      ].join("\n")
    : [
        "```ts",
        `"${modelId}": {`,
        `  inputUsdPerToken: 0, // TODO: no LiteLLM match — set from ${provider}'s pricing page`,
        `  outputUsdPerToken: 0, // TODO: no LiteLLM match — set from ${provider}'s pricing page`,
        `  typicalInputTokens: 1500, // TODO`,
        `  typicalOutputTokens: 400, // TODO`,
        `},`,
        "```",
      ].join("\n");

  return [
    `Add to \`${MODELS_CONST_NAME[provider]}\` in \`worker/src/providers/registry.ts\`:`,
    listBlock,
    "",
    `Add to \`MODEL_PRICES.${provider}\` in the same file` +
      (price ? " (**UNVERIFIED** — see checklist below):" : " (price is a TODO — no LiteLLM match):"),
    priceBlock,
  ].join("\n");
}
