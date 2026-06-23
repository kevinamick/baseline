// Mistral runtime client (#204, provider #3): the Mistral half of the LLMProvider interface,
// behind the same judge/propose/complete contract as the other clients so call sites stay
// client-agnostic (the provider→client factory picks it). Mistral's REST API is OpenAI-compatible
// chat completions, but it's a distinct client so the host is a fixed Mistral literal (the
// managed-key host-pinning guarantee, #222) and so its model/param quirks (max_tokens, not
// max_completion_tokens) stay isolated. No SDK — a direct fetch, like the OpenAI/Google clients.

import type {
  LLMProvider,
  LLMJudgeResult,
  ProposeInput,
  ProposeResult,
  TokenUsage,
} from "./llm.js";
import { isMistralModel, defaultJudgeModelForProvider, defaultReflectModelForProvider } from "./models.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { parseJudgeResponse } from "./parse-judge.js";
import { postJson } from "./http.js";
import { log } from "../log.js";

// Pin to the real Mistral host (#222): a managed/shared key must only ever leave our infra to the
// fixed provider host, never a tenant-influenced destination. A literal here, not an env override.
const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function usageOf(res: ChatCompletion, model: string): TokenUsage {
  return {
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    model,
  };
}

export class MistralProvider implements LLMProvider {
  private apiKey: string;
  private judgeModel: string;
  private reflectModel: string;

  constructor(opts?: { apiKey?: string; judgeModel?: string; reflectModel?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.MISTRAL_API_KEY ?? "";
    this.judgeModel = opts?.judgeModel ?? defaultJudgeModelForProvider("mistral");
    const requested = opts?.reflectModel;
    if (requested && !isMistralModel(requested)) {
      log.warn("Unknown Mistral reflect model; falling back to default", {
        event: "optimization_run.reflect_model_fallback",
        requested,
        fallback: defaultReflectModelForProvider("mistral"),
      });
    }
    this.reflectModel =
      requested && isMistralModel(requested) ? requested : defaultReflectModelForProvider("mistral");
  }

  private async chat(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const res = await postJson<ChatCompletion>({
      provider: "mistral",
      url: MISTRAL_API_URL,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: opts.model,
        max_tokens: opts.maxTokens,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      },
    });
    const text = res.choices?.[0]?.message?.content ?? "";
    return { text, usage: usageOf(res, opts.model) };
  }

  async judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult> {
    const { text, usage } = await this.chat({
      model: this.judgeModel,
      system: systemPrompt,
      user: userContent,
      maxTokens: 1024,
    });
    return parseJudgeResponse(text, usage);
  }

  async complete(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    return this.chat({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      maxTokens: opts.maxTokens ?? 1024,
    });
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const { system, user } = buildReflectionMessages(input);
    const { text, usage } = await this.chat({
      model: this.reflectModel,
      system,
      user,
      maxTokens: 2048,
    });
    const proposed = extractProposedPrompt(text);
    if (!proposed) throw new Error("Reflection model returned an empty prompt");
    return { prompt: proposed, usage };
  }
}
