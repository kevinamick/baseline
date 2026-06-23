// OpenAI runtime client (#204): the OpenAI half of the LLMProvider interface, behind the same
// judge/propose/complete contract as AnthropicProvider so call sites stay client-agnostic (the
// provider→client factory picks it). No SDK — it calls the Chat Completions REST API directly so
// the host is a fixed literal (the managed-key host-pinning guarantee, #222), and so the worker
// adds no dependency for a second provider.

import type {
  LLMProvider,
  LLMJudgeResult,
  ProposeInput,
  ProposeResult,
  TokenUsage,
} from "./llm.js";
import { isOpenAIModel, defaultJudgeModelForProvider, defaultReflectModelForProvider } from "./models.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { parseJudgeResponse } from "./parse-judge.js";
import { postJson } from "./http.js";
import { log } from "../log.js";

// Pin to the real OpenAI host (#222): a managed/shared key must only ever leave our infra to the
// fixed provider host, never a tenant-influenced destination. A literal here, not an env override.
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

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

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private judgeModel: string;
  private reflectModel: string;

  constructor(opts?: { apiKey?: string; judgeModel?: string; reflectModel?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!this.apiKey) throw new Error("OpenAI API key is required");
    this.judgeModel = opts?.judgeModel ?? defaultJudgeModelForProvider("openai");
    const requested = opts?.reflectModel;
    if (requested && !isOpenAIModel(requested)) {
      log.warn("Unknown OpenAI reflect model; falling back to default", {
        event: "optimization_run.reflect_model_fallback",
        requested,
        fallback: defaultReflectModelForProvider("openai"),
      });
    }
    this.reflectModel =
      requested && isOpenAIModel(requested) ? requested : defaultReflectModelForProvider("openai");
  }

  private async chat(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const res = await postJson<ChatCompletion>({
      provider: "openai",
      url: OPENAI_API_URL,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: opts.model,
        max_completion_tokens: opts.maxTokens,
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
