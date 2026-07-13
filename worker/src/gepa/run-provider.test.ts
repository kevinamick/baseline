import { describe, it, expect } from "vitest";
import { reflectProviderForRun } from "./run-provider.js";

describe("reflectProviderForRun (#485)", () => {
  it("honors the stored provider for a live-listed (non-registry) model", () => {
    expect(
      reflectProviderForRun({ reflect_model: "gpt-5.3-preview", reflect_provider: "openai" }),
    ).toBe("openai");
    expect(
      reflectProviderForRun({ reflect_model: "mistral-huge-latest", reflect_provider: "mistral" }),
    ).toBe("mistral");
  });

  it("honors the stored provider for a registry model too (they agree by construction)", () => {
    expect(reflectProviderForRun({ reflect_model: "gpt-5", reflect_provider: "openai" })).toBe(
      "openai",
    );
  });

  it("falls back to the registry map when the column is null (pre-#485 rows, byte-for-byte)", () => {
    expect(reflectProviderForRun({ reflect_model: "gpt-5", reflect_provider: null })).toBe(
      "openai",
    );
    expect(
      reflectProviderForRun({ reflect_model: "claude-sonnet-4-6", reflect_provider: null }),
    ).toBe("anthropic");
    // The registry's own fail-safe for an unknown model with no stored provider: Anthropic.
    expect(
      reflectProviderForRun({ reflect_model: "not-a-real-model", reflect_provider: null }),
    ).toBe("anthropic");
  });

  it("falls back on a stored value that isn't a known provider id (CHECK-guarded, stays total)", () => {
    expect(reflectProviderForRun({ reflect_model: "gpt-5", reflect_provider: "acme-ai" })).toBe(
      "openai",
    );
  });
});
