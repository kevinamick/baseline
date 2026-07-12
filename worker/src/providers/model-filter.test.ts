import { describe, it, expect } from "vitest";
import {
  isChatCapableAnthropicId,
  isChatCapableOpenAIId,
  isChatCapableGoogleModel,
  isChatCapableMistralModel,
  bareGoogleModelId,
  extractChatCapableModelIds,
} from "./model-filter.js";

// Fixtures modeled on each provider's real list-models response shape (trimmed to the fields
// this module reads). No network — these are recorded/representative payloads, per #484's
// acceptance criteria ("covered by unit tests over recorded/fixture API responses").

const ANTHROPIC_FIXTURE = {
  data: [
    { id: "claude-opus-4-8", type: "model" },
    { id: "claude-sonnet-4-6", type: "model" },
    { id: "claude-haiku-4-5-20251001", type: "model" },
    { id: "claude-2.1", type: "model" }, // old snapshot — still claude-*, kept (ignore-list's job)
  ],
};

const OPENAI_FIXTURE = {
  data: [
    { id: "gpt-5", object: "model" },
    { id: "gpt-5-mini", object: "model" },
    { id: "o3", object: "model" },
    { id: "o3-mini", object: "model" },
    { id: "gpt-4o-realtime-preview", object: "model" },
    { id: "gpt-4o-mini-audio-preview", object: "model" },
    { id: "gpt-4o-transcribe", object: "model" },
    { id: "text-embedding-3-large", object: "model" },
    { id: "whisper-1", object: "model" },
    { id: "tts-1", object: "model" },
    { id: "gpt-4o-mini-tts", object: "model" },
    { id: "dall-e-3", object: "model" },
    { id: "omni-moderation-latest", object: "model" },
    { id: "gpt-image-1", object: "model" },
  ],
};

const GOOGLE_FIXTURE = {
  models: [
    {
      name: "models/gemini-2.5-pro",
      supportedGenerationMethods: ["generateContent", "countTokens"],
    },
    {
      name: "models/gemini-2.5-flash",
      supportedGenerationMethods: ["generateContent", "countTokens"],
    },
    {
      name: "models/text-embedding-004",
      supportedGenerationMethods: ["embedContent"],
    },
    {
      name: "models/aqa",
      supportedGenerationMethods: ["generateAnswer"],
    },
  ],
};

const MISTRAL_FIXTURE = {
  data: [
    { id: "mistral-large-latest", capabilities: { completion_chat: true } },
    { id: "mistral-small-latest", capabilities: { completion_chat: true } },
    { id: "mistral-embed", capabilities: { completion_chat: false, embedding: true } },
    { id: "codestral-latest", capabilities: { completion_chat: true } },
    { id: "voxtral-mini", capabilities: {} }, // no completion_chat flag at all
  ],
};

describe("Anthropic chat-capable id rule", () => {
  it("keeps anything claude-* prefixed", () => {
    expect(isChatCapableAnthropicId("claude-sonnet-4-6")).toBe(true);
    expect(isChatCapableAnthropicId("claude-2.1")).toBe(true);
  });

  it("rejects non-claude ids", () => {
    expect(isChatCapableAnthropicId("some-other-model")).toBe(false);
  });
});

describe("OpenAI chat-capable id rule", () => {
  it("keeps plain gpt-*/o<digit>* chat models", () => {
    expect(isChatCapableOpenAIId("gpt-5")).toBe(true);
    expect(isChatCapableOpenAIId("gpt-5-mini")).toBe(true);
    expect(isChatCapableOpenAIId("o3")).toBe(true);
    expect(isChatCapableOpenAIId("o3-mini")).toBe(true);
  });

  it("rejects non-gpt/o-family ids", () => {
    expect(isChatCapableOpenAIId("whisper-1")).toBe(false);
    expect(isChatCapableOpenAIId("text-embedding-3-large")).toBe(false);
    expect(isChatCapableOpenAIId("dall-e-3")).toBe(false);
  });

  it("rejects gpt-*/o-family ids that are actually realtime/audio/transcribe/tts/etc", () => {
    expect(isChatCapableOpenAIId("gpt-4o-realtime-preview")).toBe(false);
    expect(isChatCapableOpenAIId("gpt-4o-mini-audio-preview")).toBe(false);
    expect(isChatCapableOpenAIId("gpt-4o-transcribe")).toBe(false);
    expect(isChatCapableOpenAIId("gpt-4o-mini-tts")).toBe(false);
    expect(isChatCapableOpenAIId("omni-moderation-latest")).toBe(false);
    expect(isChatCapableOpenAIId("gpt-image-1")).toBe(false);
  });
});

describe("Google chat-capable model rule (capability metadata)", () => {
  it("keeps models whose supportedGenerationMethods includes generateContent", () => {
    expect(isChatCapableGoogleModel(GOOGLE_FIXTURE.models[0])).toBe(true);
  });

  it("rejects embedding/other-method models", () => {
    expect(isChatCapableGoogleModel(GOOGLE_FIXTURE.models[2])).toBe(false);
    expect(isChatCapableGoogleModel(GOOGLE_FIXTURE.models[3])).toBe(false);
  });

  it("rejects a model with no supportedGenerationMethods field", () => {
    expect(isChatCapableGoogleModel({ name: "models/mystery" })).toBe(false);
  });

  it("strips the models/ path prefix", () => {
    expect(bareGoogleModelId("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(bareGoogleModelId("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });
});

describe("Mistral chat-capable model rule (capability metadata)", () => {
  it("keeps models with capabilities.completion_chat === true", () => {
    expect(isChatCapableMistralModel(MISTRAL_FIXTURE.data[0])).toBe(true);
    expect(isChatCapableMistralModel(MISTRAL_FIXTURE.data[3])).toBe(true);
  });

  it("rejects models with completion_chat === false or missing", () => {
    expect(isChatCapableMistralModel(MISTRAL_FIXTURE.data[2])).toBe(false);
    expect(isChatCapableMistralModel(MISTRAL_FIXTURE.data[4])).toBe(false);
  });
});

describe("extractChatCapableModelIds — per-provider envelope parsing + filtering", () => {
  it("Anthropic: unwraps data[], keeps claude-* ids, dedupes+sorts", () => {
    expect(extractChatCapableModelIds("anthropic", ANTHROPIC_FIXTURE)).toEqual([
      "claude-2.1",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
  });

  it("OpenAI: unwraps data[], drops embeddings/audio/tts/moderation/image noise", () => {
    expect(extractChatCapableModelIds("openai", OPENAI_FIXTURE)).toEqual([
      "gpt-5",
      "gpt-5-mini",
      "o3",
      "o3-mini",
    ]);
  });

  it("Google: unwraps models[], strips path prefix, drops embedding/other-method models", () => {
    expect(extractChatCapableModelIds("google", GOOGLE_FIXTURE)).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ]);
  });

  it("Mistral: unwraps data[], drops non-chat capability models", () => {
    expect(extractChatCapableModelIds("mistral", MISTRAL_FIXTURE)).toEqual([
      "codestral-latest",
      "mistral-large-latest",
      "mistral-small-latest",
    ]);
  });

  it("tolerates a missing/malformed envelope by returning an empty list", () => {
    expect(extractChatCapableModelIds("anthropic", {})).toEqual([]);
    expect(extractChatCapableModelIds("openai", null)).toEqual([]);
    expect(extractChatCapableModelIds("google", undefined)).toEqual([]);
  });
});
