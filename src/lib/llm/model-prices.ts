/**
 * App-facing re-export of the shared price/model registry (#379, first tracer bullet of the
 * shared-package extraction #93). MODEL_PRICES used to be hand-mirrored here and pinned to the
 * worker's copy (worker/src/providers/model-prices.ts) by a parity test asserting deep equality.
 * It now comes from the ONE definition, worker/src/providers/registry.ts, that both projects
 * import — there's nothing left to drift, so that parity test is gone.
 *
 * Client components import this module (e.g. the eval-run dialogs read ESTIMATE_JUDGE_MODEL), so
 * it must stay side-effect-free: only pure data/functions are re-exported here, never
 * defaultJudgeModelForProvider/defaultReflectModelForProvider (the registry's Node-only,
 * process.env-reading functions) — those are Node-only call sites (worker, app server
 * actions/route handlers) and import the registry directly instead.
 */
import {
  type ModelPrice,
  MODEL_PRICES,
  priceForModel,
  isPricedModel,
  type AnyModel,
  type AnthropicModel,
  type OpenAIModel,
  type GoogleModel,
  type MistralModel,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  MISTRAL_MODELS,
  MODEL_PROVIDER,
  providerForModel,
  isKnownModel,
  isAnthropicModel,
  isOpenAIModel,
  isGoogleModel,
  isMistralModel,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_JUDGE_BY_PROVIDER,
  DEFAULT_REFLECT_BY_PROVIDER,
} from "../../../worker/src/providers/registry";
import type { LlmProvider } from "@/lib/llm/providers";

export {
  type ModelPrice,
  MODEL_PRICES,
  priceForModel,
  isPricedModel,
  type AnyModel,
  type AnthropicModel,
  type OpenAIModel,
  type GoogleModel,
  type MistralModel,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  MISTRAL_MODELS,
  MODEL_PROVIDER,
  providerForModel,
  isKnownModel,
  isAnthropicModel,
  isOpenAIModel,
  isGoogleModel,
  isMistralModel,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_JUDGE_BY_PROVIDER,
  DEFAULT_REFLECT_BY_PROVIDER,
};

/**
 * The judge model/provider the pre-run estimate prices against. The worker runs the judge on
 * `ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL`; the estimate is approximate, so it prices the
 * default. Directly aliased to the registry's DEFAULT_JUDGE_MODEL/DEFAULT_REFLECT_MODEL — same
 * import, so the estimate can never price a different model than the worker's default.
 */
export const ESTIMATE_JUDGE_PROVIDER: LlmProvider = "anthropic";
export const ESTIMATE_JUDGE_MODEL = DEFAULT_JUDGE_MODEL;

/**
 * The default reflect model the optimization estimate prices against (a run may override it via
 * optimization_runs.reflect_model).
 */
export const ESTIMATE_REFLECT_MODEL = DEFAULT_REFLECT_MODEL;
