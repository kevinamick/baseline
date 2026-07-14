import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMJudgeResult,
  ProposeInput,
  ProposeResult,
  TokenUsage,
} from "./llm.js";
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
  isAnthropicModel,
  isKnownModel,
} from "./registry.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { parseJudgeResponse, JUDGE_MAX_TOKENS } from "./parse-judge.js";
import { log } from "../log.js";

// Pin the SDK to the real Anthropic API host (#222). A managed/shared platform key must only
// ever leave our infra to the fixed provider host — never to a tenant-influenced destination.
// The SDK otherwise honors ANTHROPIC_BASE_URL from the env, so we set baseURL explicitly to
// neutralize a stray/injected override and keep the managed key pinned to this host. (This
// relies on the SDK giving an explicit constructor baseURL precedence over the env var — true
// for the @anthropic-ai/sdk version pinned in worker/package.json; revisit on a major bump.)
//
// NOTE: the OpenAI/Google/Mistral managed providers are now runtime-wired too (#204, see
// registry.ts / MANAGED_KEY_ENV and the factory); each pins its own fixed host the same way
// (the fetch clients via http.ts' literal host), so the "managed key → fixed host" guarantee holds
// per-provider across every client.
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
  // judgeModel lets a call site pin the exact judge model it resolved a key + price for (#204),
  // so the provider can never call a different model than the meter priced; absent, it keeps the
  // ANTHROPIC_MODEL env override / default.
  constructor(opts?: {
    apiKey?: string;
    judgeModel?: string;
    reflectModel?: string;
    // Accept a reflectModel outside the curated registry (#485) — see factory.ts's ProviderOpts.
    allowUnlistedReflectModel?: boolean;
  }) {
    this.client = new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
      // Pin to the fixed provider host (#222) so a managed key can never be redirected off it.
      baseURL: ANTHROPIC_API_BASE_URL,
    });
    this.judgeModel = opts?.judgeModel ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL;
    // Same acceptance rule as FetchProvider (#485): a registry Anthropic model, or — when the
    // run's stored reflect_provider vouched for it (allowUnlistedReflectModel) — an id the
    // registry doesn't know at all (a live-listed model, validated against the provider's own
    // catalog at run creation). A registry model of another provider always falls back.
    const requested = opts?.reflectModel;
    const accepted =
      requested &&
      (isAnthropicModel(requested) ||
        (opts?.allowUnlistedReflectModel === true && !isKnownModel(requested)))
        ? requested
        : null;
    if (requested && !accepted) {
      log.warn("Unknown reflect model; falling back to default", {
        event: "optimization_run.reflect_model_fallback",
        requested,
        fallback: DEFAULT_REFLECT_MODEL,
      });
    }
    this.reflectModel = accepted ?? DEFAULT_REFLECT_MODEL;
  }

  async judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult> {
    const message = await this.client.messages.create({
      model: this.judgeModel,
      // Shared across every provider's judge() call (#436) — see parse-judge.ts for why 4096.
      max_tokens: JUDGE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";
    const usage = usageOf(message, this.judgeModel);
    return parseJudgeResponse(text, usage);
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
