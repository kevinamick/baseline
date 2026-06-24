// OpenAI runtime client (#204): the OpenAI half of the LLMProvider interface, behind the same
// judge/propose/complete contract as AnthropicProvider so call sites stay client-agnostic (the
// provider→client factory picks it). No SDK — it calls the Chat Completions REST API directly so
// the host is a fixed literal (the managed-key host-pinning guarantee, #222), and so the worker
// adds no dependency for a second provider. The shared judge/propose/complete flow lives in
// FetchProvider; this file is just OpenAI's wire format.

import type { TokenUsage } from "./llm.js";
import { isOpenAIModel } from "./models.js";
import { FetchProvider, type ProviderAdapter, type ProviderClientOpts } from "./fetch-provider.js";

// Pin to the real OpenAI host (#222): a managed/shared key must only ever leave our infra to the
// fixed provider host, never a tenant-influenced destination. A literal, not a tenant input.
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const OPENAI_ADAPTER: ProviderAdapter = {
  provider: "openai",
  label: "OpenAI",
  envApiKey: () => process.env.OPENAI_API_KEY,
  isModel: isOpenAIModel,
  request: ({ model, system, user, maxTokens, apiKey }) => ({
    url: OPENAI_API_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      model,
      max_completion_tokens: maxTokens,
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

export class OpenAIProvider extends FetchProvider {
  constructor(opts?: ProviderClientOpts) {
    super(OPENAI_ADAPTER, opts);
  }
}
