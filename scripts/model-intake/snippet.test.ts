import { describe, it, expect } from "vitest";
import { buildRegistrySnippet } from "./snippet.ts";
import type { PriceSuggestion } from "./litellm-prices.ts";

describe("buildRegistrySnippet", () => {
  it("references the correct per-provider MODELS const and MODEL_PRICES key", () => {
    const snippet = buildRegistrySnippet("google", "gemini-3-flash", null);
    expect(snippet).toContain("GOOGLE_MODELS");
    expect(snippet).toContain("MODEL_PRICES.google");
    expect(snippet).toContain('"gemini-3-flash"');
  });

  it("pre-fills the price row from a LiteLLM suggestion, marked UNVERIFIED", () => {
    const price: PriceSuggestion = {
      inputUsdPerToken: 0.000002,
      outputUsdPerToken: 0.00001,
      sourceKey: "claude-opus-4-9",
    };
    const snippet = buildRegistrySnippet("anthropic", "claude-opus-4-9", price);
    expect(snippet).toContain("inputUsdPerToken: 0.000002");
    expect(snippet).toContain("outputUsdPerToken: 0.00001");
    expect(snippet).toContain("UNVERIFIED");
    expect(snippet).toContain("claude-opus-4-9");
    expect(snippet).not.toContain("no LiteLLM match");
  });

  it("falls back to explicit TODO prices when there's no LiteLLM match", () => {
    const snippet = buildRegistrySnippet("mistral", "mistral-medium-latest", null);
    expect(snippet).toContain("TODO: no LiteLLM match");
    expect(snippet).not.toContain("UNVERIFIED");
  });
});
