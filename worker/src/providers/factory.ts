// Provider→client factory (#204): pick the concrete runtime client for a model, keyed off
// providerForModel(). Every call site that used to `new AnthropicProvider(...)` now goes through
// here, so adding a provider is one `case` plus its client class — the judge/reflect/managed-agent
// call sites never change. Each client pins its own fixed provider host (#222), so a resolved
// managed key can only ever leave our infra to the real provider.

import type { RuntimeProvider } from "./llm.js";
import { providerForModel } from "./models.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GoogleProvider } from "./google.js";
import type { LlmProvider } from "./provider-list.js";

export interface ProviderOpts {
  apiKey?: string;
  // The exact judge model the caller resolved a key + price for, so the client never calls a
  // different model than the meter priced (#204). Ignored by complete() (it takes an explicit model).
  judgeModel?: string;
  // The run's reflect/generation model; validated per-provider, falling back to that provider's
  // default when it isn't a model the provider serves.
  reflectModel?: string;
}

/** Construct the runtime client for an explicit provider. */
export function createProvider(provider: LlmProvider, opts?: ProviderOpts): RuntimeProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(opts);
    case "openai":
      return new OpenAIProvider(opts);
    case "google":
      return new GoogleProvider(opts);
  }
}

/** Construct the runtime client that serves a given model (#204). */
export function createProviderForModel(model: string, opts?: ProviderOpts): RuntimeProvider {
  return createProvider(providerForModel(model), opts);
}
