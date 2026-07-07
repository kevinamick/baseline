// Mistral runtime client (#204, provider #3): the Mistral half of the LLMProvider interface,
// behind the same judge/propose/complete contract as the other clients so call sites stay
// client-agnostic (the provider→client factory picks it). Mistral's REST API is OpenAI-compatible
// chat completions, but it's a distinct client so the host is a fixed Mistral literal (the
// managed-key host-pinning guarantee, #222) and so its param quirks (max_tokens, not
// max_completion_tokens) stay isolated. No SDK — a direct fetch, like the OpenAI/Google clients;
// the shared judge/propose/complete flow lives in FetchProvider, this file is just the wire format.

import type { TokenUsage } from "./llm.js";
import { isMistralModel } from "./registry.js";
import { FetchProvider, type ProviderAdapter, type ProviderClientOpts } from "./fetch-provider.js";

// Pin to the real Mistral host (#222): a managed/shared key must only ever leave our infra to the
// fixed provider host, never a tenant-influenced destination. A literal, not a tenant input.
const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const MISTRAL_ADAPTER: ProviderAdapter = {
  provider: "mistral",
  label: "Mistral",
  envApiKey: () => process.env.MISTRAL_API_KEY,
  isModel: isMistralModel,
  request: ({ model, system, user, maxTokens, apiKey }) => ({
    url: MISTRAL_API_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      model,
      // Mistral uses max_tokens, not OpenAI's max_completion_tokens.
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  }),
  parseResponse: (res, model): { text: string; usage: TokenUsage } => {
    const r = res as ChatCompletion;
    return {
      text: r.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens: r.usage?.prompt_tokens ?? 0,
        outputTokens: r.usage?.completion_tokens ?? 0,
        model,
      },
    };
  },
};

export class MistralProvider extends FetchProvider {
  constructor(opts?: ProviderClientOpts) {
    super(MISTRAL_ADAPTER, opts);
  }
}
