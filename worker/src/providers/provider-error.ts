import Anthropic from "@anthropic-ai/sdk";
import { ProviderHttpError } from "./http.js";
import { isLlmProvider, type LlmProvider } from "./registry.js";

// A run-time provider call rejection, normalized across the two client shapes the worker uses:
// the fetch-based clients (OpenAI/Google/Mistral) throw `ProviderHttpError`, while the Anthropic
// SDK throws `Anthropic.APIError`. Both carry the HTTP status the provider returned; the status
// is what lets an operator tell an auth/quota rejection (401/403/429) from a provider-side blip
// (5xx). `provider` is the LLM provider whose call failed, when the error identifies it — used to
// look up which resolved key (judge vs target) was in play and whether it was the customer's BYO
// key. This NEVER exposes the key/secret: only the provider name + HTTP status travel out.
export interface ProviderCallFailure {
  provider: LlmProvider | null;
  status: number | null;
}

/**
 * Classify a thrown error as a provider HTTP failure, or null if it is not one (a DB error, a
 * missing-key throw, a logic error, etc. — none of which implicate a provider key). The Anthropic
 * branch maps to the "anthropic" provider explicitly; the SDK error does not name the provider.
 */
export function classifyProviderError(
  err: unknown,
): ProviderCallFailure | null {
  if (err instanceof ProviderHttpError) {
    return {
      provider: isLlmProvider(err.provider) ? err.provider : null,
      status: err.status,
    };
  }
  if (err instanceof Anthropic.APIError) {
    return { provider: "anthropic", status: err.status ?? null };
  }
  return null;
}
