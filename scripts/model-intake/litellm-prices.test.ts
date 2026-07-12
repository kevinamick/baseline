import { describe, it, expect } from "vitest";
import { suggestPriceFromLiteLlm, fetchLiteLlmData, type LiteLlmData } from "./litellm-prices.ts";

// A trimmed fixture in LiteLLM's real shape: bare keys for Anthropic/OpenAI, vendor-prefixed
// keys for Google/Mistral, plus a couple of non-matching / malformed rows to prove robustness.
const LITELLM_FIXTURE: LiteLlmData = {
  "claude-sonnet-4-6": {
    litellm_provider: "anthropic",
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    mode: "chat",
  },
  "claude-opus-4-9": {
    litellm_provider: "anthropic",
    input_cost_per_token: 0.00002,
    output_cost_per_token: 0.0001,
    mode: "chat",
  },
  "gpt-5.1": {
    litellm_provider: "openai",
    input_cost_per_token: 0.0000015,
    output_cost_per_token: 0.000012,
    mode: "chat",
  },
  "gemini/gemini-3-pro": {
    litellm_provider: "vertex_ai-language-models",
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000009,
    mode: "chat",
  },
  "mistral/mistral-medium-latest": {
    litellm_provider: "mistral",
    input_cost_per_token: 0.0000004,
    output_cost_per_token: 0.000002,
    mode: "chat",
  },
  // Same bare id as an Anthropic model but under a different provider — must NOT cross-match.
  "openai/claude-sonnet-4-6": {
    litellm_provider: "openai",
    input_cost_per_token: 0.0000009,
    output_cost_per_token: 0.000009,
    mode: "chat",
  },
  // Missing price fields — must be skipped even if id/provider match.
  "gpt-5-nano": {
    litellm_provider: "openai",
    mode: "chat",
  },
};

describe("suggestPriceFromLiteLlm", () => {
  it("matches a bare-keyed Anthropic entry", () => {
    expect(suggestPriceFromLiteLlm("anthropic", "claude-opus-4-9", LITELLM_FIXTURE)).toEqual({
      inputUsdPerToken: 0.00002,
      outputUsdPerToken: 0.0001,
      sourceKey: "claude-opus-4-9",
    });
  });

  it("matches a bare-keyed OpenAI entry", () => {
    expect(suggestPriceFromLiteLlm("openai", "gpt-5.1", LITELLM_FIXTURE)).toEqual({
      inputUsdPerToken: 0.0000015,
      outputUsdPerToken: 0.000012,
      sourceKey: "gpt-5.1",
    });
  });

  it("matches a vendor-prefixed Google entry via litellm_provider", () => {
    expect(suggestPriceFromLiteLlm("google", "gemini-3-pro", LITELLM_FIXTURE)).toEqual({
      inputUsdPerToken: 0.000002,
      outputUsdPerToken: 0.000009,
      sourceKey: "gemini/gemini-3-pro",
    });
  });

  it("matches a vendor-prefixed Mistral entry via litellm_provider", () => {
    expect(suggestPriceFromLiteLlm("mistral", "mistral-medium-latest", LITELLM_FIXTURE)).toEqual({
      inputUsdPerToken: 0.0000004,
      outputUsdPerToken: 0.000002,
      sourceKey: "mistral/mistral-medium-latest",
    });
  });

  it("does not cross-match the same bare id under a different provider", () => {
    expect(suggestPriceFromLiteLlm("anthropic", "claude-sonnet-4-6", LITELLM_FIXTURE)).toEqual({
      inputUsdPerToken: 0.000003,
      outputUsdPerToken: 0.000015,
      sourceKey: "claude-sonnet-4-6",
    });
  });

  it("returns null for a model with no matching entry", () => {
    expect(suggestPriceFromLiteLlm("anthropic", "claude-made-up", LITELLM_FIXTURE)).toBeNull();
  });

  it("returns null when the matching entry is missing usable price fields", () => {
    expect(suggestPriceFromLiteLlm("openai", "gpt-5-nano", LITELLM_FIXTURE)).toBeNull();
  });
});

describe("fetchLiteLlmData — degrades to null, never throws", () => {
  it("returns the parsed data on a 200 with a JSON object body", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ foo: { input_cost_per_token: 1 } }), {
        status: 200,
      })) as typeof fetch;
    const data = await fetchLiteLlmData(fakeFetch);
    expect(data).toEqual({ foo: { input_cost_per_token: 1 } });
  });

  it("returns null on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(await fetchLiteLlmData(fakeFetch)).toBeNull();
  });

  it("returns null when the fetch throws (network error)", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await fetchLiteLlmData(fakeFetch)).toBeNull();
  });

  it("returns null when the body isn't a JSON object", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify("not an object"), {
      status: 200,
    })) as typeof fetch;
    expect(await fetchLiteLlmData(fakeFetch)).toBeNull();
  });

  it("returns null when the body isn't valid JSON at all", async () => {
    const fakeFetch = (async () => new Response("<html>not json</html>", {
      status: 200,
    })) as typeof fetch;
    expect(await fetchLiteLlmData(fakeFetch)).toBeNull();
  });
});
