// Google Gemini runtime client (#204): the Google half of the LLMProvider interface, behind the
// same judge/propose/complete contract as AnthropicProvider so call sites stay client-agnostic
// (the provider→client factory picks it). No SDK — it calls the Generative Language REST API
// directly so the host is a fixed literal (the managed-key host-pinning guarantee, #222), and the
// key rides an x-goog-api-key header rather than the URL so it never lands in a log line.

import type {
  LLMProvider,
  LLMJudgeResult,
  ProposeInput,
  ProposeResult,
  TokenUsage,
} from "./llm.js";
import { isGoogleModel, defaultJudgeModelForProvider, defaultReflectModelForProvider } from "./models.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { parseJudgeResponse } from "./parse-judge.js";
import { postJson } from "./http.js";
import { log } from "../log.js";

// Pin to the real Google host (#222): a managed/shared key must only ever leave our infra to the
// fixed provider host. A literal here, not an env override.
const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function usageOf(res: GenerateContentResponse, model: string): TokenUsage {
  return {
    inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    model,
  };
}

export class GoogleProvider implements LLMProvider {
  private apiKey: string;
  private judgeModel: string;
  private reflectModel: string;

  constructor(opts?: { apiKey?: string; judgeModel?: string; reflectModel?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    if (!this.apiKey) throw new Error("Google API key is required");
    this.judgeModel = opts?.judgeModel ?? defaultJudgeModelForProvider("google");
    const requested = opts?.reflectModel;
    if (requested && !isGoogleModel(requested)) {
      log.warn("Unknown Google reflect model; falling back to default", {
        event: "optimization_run.reflect_model_fallback",
        requested,
        fallback: defaultReflectModelForProvider("google"),
      });
    }
    this.reflectModel =
      requested && isGoogleModel(requested) ? requested : defaultReflectModelForProvider("google");
  }

  private async generate(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const res = await postJson<GenerateContentResponse>({
      provider: "google",
      // The model is a fixed-format path segment; the key never rides the URL (header below).
      url: `${GOOGLE_API_BASE}/${encodeURIComponent(opts.model)}:generateContent`,
      headers: { "x-goog-api-key": this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts: [{ text: opts.user }] }],
        generationConfig: { maxOutputTokens: opts.maxTokens },
      },
    });
    const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { text, usage: usageOf(res, opts.model) };
  }

  async judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult> {
    const { text, usage } = await this.generate({
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
    return this.generate({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      maxTokens: opts.maxTokens ?? 1024,
    });
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const { system, user } = buildReflectionMessages(input);
    const { text, usage } = await this.generate({
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
