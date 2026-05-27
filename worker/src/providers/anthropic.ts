import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMJudgeResult } from "./llm.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult> {
    const message = await this.client.messages.create({
      model: MODEL,
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
}
