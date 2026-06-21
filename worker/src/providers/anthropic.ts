import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMJudgeResult,
  ProposeInput,
  ProposeResult,
  TokenUsage,
} from "./llm.js";
import { DEFAULT_JUDGE_MODEL, DEFAULT_REFLECT_MODEL, isAnthropicModel } from "./models.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { log } from "../log.js";

// Pin the SDK to the real Anthropic API host (#222). A managed/shared platform key must only
// ever leave our infra to the fixed provider host — never to a tenant-influenced destination.
// The SDK otherwise honors ANTHROPIC_BASE_URL from the env, so we set baseURL explicitly to
// neutralize a stray/injected override and keep the managed key pinned to this host. (This
// relies on the SDK giving an explicit constructor baseURL precedence over the env var — true
// for the @anthropic-ai/sdk version pinned in worker/package.json; revisit on a major bump.)
//
// NOTE: when openai/google managed providers get runtime-wired (see provider-list.ts /
// MANAGED_KEY_ENV — today only 'anthropic' is constructed in worker.ts), each must pin its own
// fixed host the same way. The "managed key → fixed host" guarantee is per-provider until then.
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

// Cache-read/creation tokens still cost input, so fold them into the input
// count — the managed meter prices what the provider actually billed (#185).
function usageOf(message: Anthropic.Message, model: string): TokenUsage {
  const u = message.usage;
  return {
    inputTokens:
      (u?.input_tokens ?? 0) +
      (u?.cache_creation_input_tokens ?? 0) +
      (u?.cache_read_input_tokens ?? 0),
    outputTokens: u?.output_tokens ?? 0,
    model,
  };
}

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
      // Pin to the fixed provider host (#222) so a managed key can never be redirected off it.
      baseURL: ANTHROPIC_API_BASE_URL,
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
    const usage = usageOf(message, this.judgeModel);

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON object found in response");
      const parsed = JSON.parse(jsonMatch[0]) as { score: unknown; reasoning: unknown };
      const score = Math.max(0, Math.min(1, Number(parsed.score)));
      const reasoning = String(parsed.reasoning ?? "");
      return { score, reasoning, usage };
    } catch {
      // Fallback: score 0 with raw response as reasoning. The call still cost
      // tokens, so usage is reported either way (the run is metered on attempts).
      return { score: 0, reasoning: `Parse error. Raw: ${text.slice(0, 500)}`, usage };
    }
  }

  // Run the model as a Managed Agent System (#290): the Candidate's resolved prompt is the
  // system message, the instance input the user turn. Returns the text output plus token usage
  // so the managed meter can price it (#185 wiring lands in #291). Goes through this provider —
  // never a raw SDK call — so a managed key stays pinned to the fixed Anthropic host (#222).
  async complete(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const message = await this.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    });
    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    return { text, usage: usageOf(message, opts.model) };
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const { system, user } = buildReflectionMessages(input);
    const message = await this.client.messages.create({
      model: this.reflectModel,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    });

    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    const usage = usageOf(message, this.reflectModel);
    const proposed = extractProposedPrompt(text);
    // A model that returns nothing usable shouldn't silently install an empty prompt; keep
    // the parent's prompt by surfacing the failure so the accept/reject gate never runs on it.
    if (!proposed) throw new Error("Reflection model returned an empty prompt");
    return { prompt: proposed, usage };
  }
}
