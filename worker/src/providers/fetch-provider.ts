// Shared base for the fetch-based runtime clients (#204). OpenAI, Google, and Mistral all ship no
// SDK in the worker and implement the same judge/propose/complete control flow — only the wire
// format (URL, headers, request body, response shape) and the per-provider constructor strings
// differ. That control flow lived copy-pasted in three files; it lives here once, and each provider
// supplies a small `ProviderAdapter` describing its wire format. Anthropic keeps its own class (it
// uses the SDK, not fetch). Each adapter still owns a fixed host literal (the managed-key
// host-pinning guarantee, #222).

import type {
  RuntimeProvider,
  LLMJudgeResult,
  ProposeInput,
  ProposeResult,
  TokenUsage,
} from "./llm.js";
import {
  defaultJudgeModelForProvider,
  defaultReflectModelForProvider,
  type LlmProvider,
} from "./registry.js";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import { parseJudgeResponse } from "./parse-judge.js";
import { postJson } from "./http.js";
import { log } from "../log.js";

// The fetch clients default to reasoning models (GPT-5/GPT-5-mini, Gemini 2.5 Pro/Flash, whose
// thinking is on by default). Reasoning/thinking tokens are spent from the output budget BEFORE any
// visible text, so a tight cap can be fully consumed by reasoning and return empty content — which
// silently scores the judge 0 (parseJudgeResponse) and throws "empty prompt" on reflect. Give
// generous ceilings so reasoning has headroom and the visible JSON verdict / rewritten prompt still
// lands. A ceiling, not a target: the model is billed for what it actually emits (#204).
const JUDGE_MAX_TOKENS = 4096;
const REFLECT_MAX_TOKENS = 8192;
const COMPLETE_MAX_TOKENS = 4096;

/** Constructor options shared by every fetch client: the resolved key plus the run's models. */
export interface ProviderClientOpts {
  apiKey?: string;
  // The exact judge model the caller resolved a key + price for, so the client never calls a
  // different model than the meter priced (#204).
  judgeModel?: string;
  // The run's reflect/generation model; validated against the provider's model set, falling back
  // to that provider's default when it isn't a model the provider serves.
  reflectModel?: string;
}

/** A single prepared HTTP request for one model call. */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * One provider's wire adapter: everything that differs between OpenAI, Google, and Mistral. The
 * shared FetchProvider owns the judge/propose/complete control flow; the adapter owns the format.
 */
export interface ProviderAdapter {
  /** Lowercase provider id, used for the model→provider routing and HTTP-error labelling. */
  provider: LlmProvider;
  /** Display name for the "X API key is required" guard (e.g. "OpenAI", not "openai"). */
  label: string;
  /** The platform env key, read at construction when a caller constructs without an explicit key. */
  envApiKey(): string | undefined;
  /** Whether a model id belongs to this provider (guards a stray per-run reflect-model override). */
  isModel(model: string): boolean;
  /** Build the request for one call. The host is a fixed literal owned by the adapter (#222). */
  request(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
    apiKey: string;
  }): ProviderRequest;
  /** Parse the raw JSON response into the model's text output + token usage. */
  parseResponse(res: unknown, model: string): { text: string; usage: TokenUsage };
}

export abstract class FetchProvider implements RuntimeProvider {
  protected readonly apiKey: string;
  protected readonly judgeModel: string;
  protected readonly reflectModel: string;

  protected constructor(
    private readonly adapter: ProviderAdapter,
    opts?: ProviderClientOpts,
  ) {
    this.apiKey = opts?.apiKey ?? adapter.envApiKey() ?? "";
    if (!this.apiKey) throw new Error(`${adapter.label} API key is required`);
    this.judgeModel = opts?.judgeModel ?? defaultJudgeModelForProvider(adapter.provider);
    const requested = opts?.reflectModel;
    if (requested && !adapter.isModel(requested)) {
      log.warn(`Unknown ${adapter.label} reflect model; falling back to default`, {
        event: "optimization_run.reflect_model_fallback",
        requested,
        fallback: defaultReflectModelForProvider(adapter.provider),
      });
    }
    this.reflectModel =
      requested && adapter.isModel(requested)
        ? requested
        : defaultReflectModelForProvider(adapter.provider);
  }

  private async run(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const { url, headers, body } = this.adapter.request({ ...opts, apiKey: this.apiKey });
    const res = await postJson<unknown>({ provider: this.adapter.provider, url, headers, body });
    return this.adapter.parseResponse(res, opts.model);
  }

  async judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult> {
    const { text, usage } = await this.run({
      model: this.judgeModel,
      system: systemPrompt,
      user: userContent,
      maxTokens: JUDGE_MAX_TOKENS,
    });
    return parseJudgeResponse(text, usage);
  }

  async complete(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ text: string; usage: TokenUsage }> {
    return this.run({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      maxTokens: opts.maxTokens ?? COMPLETE_MAX_TOKENS,
    });
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const { system, user } = buildReflectionMessages(input);
    const { text, usage } = await this.run({
      model: this.reflectModel,
      system,
      user,
      maxTokens: REFLECT_MAX_TOKENS,
    });
    const proposed = extractProposedPrompt(text);
    if (!proposed) throw new Error("Reflection model returned an empty prompt");
    return { prompt: proposed, usage };
  }
}
