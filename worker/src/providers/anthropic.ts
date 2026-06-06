import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMJudgeResult, ProposeInput } from "./llm.js";
import { DEFAULT_JUDGE_MODEL, DEFAULT_REFLECT_MODEL } from "./models.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private judgeModel: string;
  private reflectModel: string;

  // judgeModel stays Haiku by default (ANTHROPIC_MODEL keeps its existing override);
  // reflectModel defaults to Sonnet and is overridable per Optimization Run (D7).
  constructor(opts?: { reflectModel?: string }) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.judgeModel = process.env.ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL;
    this.reflectModel = opts?.reflectModel ?? DEFAULT_REFLECT_MODEL;
  }

  async judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult> {
    const message = await this.client.messages.create({
      model: this.judgeModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON object found in response");
      const parsed = JSON.parse(jsonMatch[0]) as { score: unknown; reasoning: unknown };
      const score = Math.max(0, Math.min(1, Number(parsed.score)));
      const reasoning = String(parsed.reasoning ?? "");
      return { score, reasoning };
    } catch {
      // Fallback: score 0 with raw response as reasoning
      return { score: 0, reasoning: `Parse error. Raw: ${text.slice(0, 500)}` };
    }
  }

  async propose(input: ProposeInput): Promise<string> {
    const { system, user } = buildReflectionMessages(input);
    const message = await this.client.messages.create({
      model: this.reflectModel,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const proposed = extractProposedPrompt(text);
    // A model that returns nothing usable shouldn't silently install an empty prompt; keep
    // the parent's prompt by surfacing the failure so the accept/reject gate never runs on it.
    if (!proposed) throw new Error("Reflection model returned an empty prompt");
    return proposed;
  }
}
