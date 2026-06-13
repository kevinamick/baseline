import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMJudgeResult, ProposeInput } from "./llm.js";
import { DEFAULT_JUDGE_MODEL, DEFAULT_REFLECT_MODEL, isAnthropicModel } from "./models.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { log } from "../log.js";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private judgeModel: string;
  private reflectModel: string;

  // judgeModel stays Haiku by default (ANTHROPIC_MODEL keeps its existing override);
  // reflectModel defaults to Sonnet and is overridable per Optimization Run (D7). An override
  // is validated against the single-sourced model set — an unrecognized value (e.g. a typo
  // stored in optimization_runs.reflect_model) falls back to the default rather than reaching
  // the API as a guaranteed error that would fail the whole run.
  //
  // apiKey is the per-Team resolved key (BYO or managed, #184); it falls back to the
  // platform ANTHROPIC_API_KEY env only when a caller constructs the provider without one.
  constructor(opts?: { apiKey?: string; reflectModel?: string }) {
    this.client = new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.judgeModel = process.env.ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL;
    const requested = opts?.reflectModel;
    if (requested && !isAnthropicModel(requested)) {
      log.warn("Unknown reflect model; falling back to default", {
        event: "optimization_run.reflect_model_fallback",
        requested,
        fallback: DEFAULT_REFLECT_MODEL,
      });
    }
    this.reflectModel =
      requested && isAnthropicModel(requested) ? requested : DEFAULT_REFLECT_MODEL;
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

    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    const proposed = extractProposedPrompt(text);
    // A model that returns nothing usable shouldn't silently install an empty prompt; keep
    // the parent's prompt by surfacing the failure so the accept/reject gate never runs on it.
    if (!proposed) throw new Error("Reflection model returned an empty prompt");
    return proposed;
  }
}
