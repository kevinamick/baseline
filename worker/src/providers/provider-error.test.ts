import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { classifyProviderError } from "./provider-error.js";
import { ProviderHttpError } from "./http.js";

describe("classifyProviderError", () => {
  it("classifies a fetch-client ProviderHttpError with its provider + status", () => {
    const err = new ProviderHttpError(
      "openai",
      401,
      '{"error":"invalid api key"}',
    );
    expect(classifyProviderError(err)).toEqual({
      provider: "openai",
      status: 401,
    });
  });

  it("maps an unknown ProviderHttpError provider string to null (still carries status)", () => {
    const err = new ProviderHttpError(
      "totally-not-a-provider",
      429,
      "rate limited",
    );
    expect(classifyProviderError(err)).toEqual({ provider: null, status: 429 });
  });

  it("classifies an Anthropic SDK APIError as the anthropic provider with its status", () => {
    // Anthropic.APIError(status, error, message, headers)
    const err = new Anthropic.APIError(403, undefined, "forbidden", undefined);
    const result = classifyProviderError(err);
    expect(result?.provider).toBe("anthropic");
    expect(result?.status).toBe(403);
  });

  it("returns null for a non-provider error (a DB/logic error never implicates a key)", () => {
    expect(
      classifyProviderError(new Error("Failed to load rows: timeout")),
    ).toBeNull();
    expect(classifyProviderError("a string")).toBeNull();
  });
});
