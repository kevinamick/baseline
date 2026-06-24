// Google Gemini runtime client (#204): the Google half of the LLMProvider interface, behind the
// same judge/propose/complete contract as AnthropicProvider so call sites stay client-agnostic
// (the provider→client factory picks it). No SDK — it calls the Generative Language REST API
// directly so the host is a fixed literal (the managed-key host-pinning guarantee, #222), and the
// key rides an x-goog-api-key header rather than the URL so it never lands in a log line. The
// shared judge/propose/complete flow lives in FetchProvider; this file is just Google's wire format.

import type { TokenUsage } from "./llm.js";
import { isGoogleModel } from "./models.js";
import { FetchProvider, type ProviderAdapter, type ProviderClientOpts } from "./fetch-provider.js";

// Pin to the real Google host (#222): a managed/shared key must only ever leave our infra to the
// fixed provider host. The literal is the production default. GOOGLE_API_BASE_OVERRIDE is an
// operator-only escape hatch (set in the deploy env, never tenant-influenced) so local dev and
// tests can point at a mock/proxy host — it does NOT weaken the #222 guarantee, which is about
// tenant-controlled destinations, since tenants cannot set worker env vars.
const GOOGLE_API_BASE =
  process.env.GOOGLE_API_BASE_OVERRIDE ?? "https://generativelanguage.googleapis.com/v1beta/models";

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    // Gemini 2.5 reports thinking tokens separately and excludes them from candidatesTokenCount,
    // yet bills them as output. Fold them into the output total so managed metering doesn't
    // under-count spend (and under-enforce the spend cap). (#204)
    thoughtsTokenCount?: number;
  };
}

const GOOGLE_ADAPTER: ProviderAdapter = {
  provider: "google",
  label: "Google",
  envApiKey: () => process.env.GOOGLE_API_KEY,
  isModel: isGoogleModel,
  request: ({ model, system, user, maxTokens, apiKey }) => ({
    // The model is a fixed-format path segment; the key never rides the URL (header below).
    url: `${GOOGLE_API_BASE}/${encodeURIComponent(model)}:generateContent`,
    headers: { "x-goog-api-key": apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    },
  }),
  parseResponse: (res, model): { text: string; usage: TokenUsage } => {
    const r = res as GenerateContentResponse;
    return {
      text: r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
      usage: {
        inputTokens: r.usageMetadata?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output but reported apart from candidatesTokenCount.
        outputTokens:
          (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0),
        model,
      },
    };
  },
};

export class GoogleProvider extends FetchProvider {
  constructor(opts?: ProviderClientOpts) {
    super(GOOGLE_ADAPTER, opts);
  }
}
