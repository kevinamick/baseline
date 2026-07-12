/**
 * Suggested prices cross-referenced from LiteLLM's public, community-maintained
 * `model_prices_and_context_window.json` (#484). This is a SUGGESTION INPUT ONLY, never a source
 * of truth — ADR-0008 requires a curated, human-verified price before any managed call can run on
 * it (a wrong auto-ingested price would become billed history via managed_spend_ledger
 * snapshots). Every suggestion this module produces must be surfaced to the human as UNVERIFIED.
 *
 * A LiteLLM fetch failure (network error, non-200, malformed JSON) degrades to `null` — never
 * throws — so the caller can fall back to TODO prices rather than failing the whole detection run.
 */
import type { LlmProvider } from "../../worker/src/providers/registry.ts";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** The subset of LiteLLM's per-model record shape this module reads. */
export interface LiteLlmEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  mode?: string;
}

export type LiteLlmData = Record<string, LiteLlmEntry>;

export interface PriceSuggestion {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  /** The LiteLLM dataset key the suggestion was matched from, surfaced in the report so a human
   *  reviewer can jump straight to the matched entry when verifying. */
  sourceKey: string;
}

// LiteLLM keys models either bare ("gpt-5", "claude-sonnet-4-6") or vendor-prefixed
// ("gemini/gemini-2.5-pro", "mistral/mistral-large-latest"); it also carries a `litellm_provider`
// field that's more reliable than the key prefix. Match on litellm_provider when present, falling
// back to the key's own prefix. Token lists are deliberately generous (LiteLLM's provider strings
// drift — "vertex_ai-language-models" for some Gemini rows) since a false-positive match is caught
// by the exact bare-id compare below.
const LITELLM_PROVIDER_TOKENS: Record<LlmProvider, string[]> = {
  anthropic: ["anthropic"],
  openai: ["openai", "text-completion-openai"],
  google: ["gemini", "vertex_ai"],
  mistral: ["mistral"],
};

function bareModelKey(key: string): string {
  const idx = key.indexOf("/");
  return idx === -1 ? key : key.slice(idx + 1);
}

/**
 * Cross-reference a live model id against the LiteLLM dataset. Returns null when no confident
 * match exists (no entry for this provider+id, or the entry is missing usable price fields) —
 * callers must treat that as "no suggestion," falling back to a TODO price.
 */
export function suggestPriceFromLiteLlm(
  provider: LlmProvider,
  modelId: string,
  data: LiteLlmData
): PriceSuggestion | null {
  const tokens = LITELLM_PROVIDER_TOKENS[provider];
  const needle = modelId.toLowerCase();

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;

    const providerToken = entry.litellm_provider;
    const matchesProvider = providerToken
      ? tokens.some((t) => providerToken === t || providerToken.startsWith(`${t}-`))
      : tokens.some((t) => key.startsWith(`${t}/`));
    if (!matchesProvider) continue;

    if (bareModelKey(key).toLowerCase() !== needle) continue;

    if (
      typeof entry.input_cost_per_token !== "number" ||
      typeof entry.output_cost_per_token !== "number"
    ) {
      continue;
    }

    return {
      inputUsdPerToken: entry.input_cost_per_token,
      outputUsdPerToken: entry.output_cost_per_token,
      sourceKey: key,
    };
  }

  return null;
}

/**
 * Fetch + parse the LiteLLM price dataset. Never throws: a network failure, non-2xx response, or
 * unparseable/non-object body all degrade to null (the acceptance criteria: "A LiteLLM fetch
 * failure degrades to TODO prices, not a script failure").
 */
export async function fetchLiteLlmData(
  fetchImpl: typeof fetch = fetch
): Promise<LiteLlmData | null> {
  try {
    const res = await fetchImpl(LITELLM_PRICES_URL);
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (!json || typeof json !== "object") return null;
    return json as LiteLlmData;
  } catch {
    return null;
  }
}
