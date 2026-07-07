import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// AnthropicProvider (#204/#290): judge()/propose() plus the constructor's reflect-model
// validation. anthropic-complete.test.ts already covers complete(); this file rounds out
// judge/propose and the fallback-warning branch, mocking the SDK so this stays a self-
// contained unit (no network). Host pinning (#222) is asserted in managed-key-isolation.test.ts.
const create = vi.fn();
const clientCtor = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
    constructor(opts: unknown) {
      clientCtor(opts);
    }
  },
}));
vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { AnthropicProvider } from "./anthropic.js";
import { log } from "../log.js";

describe("AnthropicProvider.judge (#204)", () => {
  beforeEach(() => create.mockReset());

  it("parses the JSON verdict and reports cache-folded token usage", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: '{"score": 0.9, "reasoning": "great"}' }],
      usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 3 },
    });
    const provider = new AnthropicProvider({ apiKey: "k", judgeModel: "claude-haiku-4-5-20251001" });

    const res = await provider.judge("You are a judge.", "Score this.");

    expect(res.score).toBe(0.9);
    expect(res.reasoning).toBe("great");
    expect(res.usage).toEqual({
      inputTokens: 23,
      outputTokens: 10,
      model: "claude-haiku-4-5-20251001",
    });
    expect(create).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: "You are a judge.",
      messages: [{ role: "user", content: "Score this." }],
    });
  });

  it("returns empty text (and a parse-error result) when the model yields no text block", async () => {
    create.mockResolvedValue({ content: [{ type: "image" }], usage: { input_tokens: 1, output_tokens: 0 } });
    const provider = new AnthropicProvider({ apiKey: "k" });
    const res = await provider.judge("S", "U");
    expect(res.score).toBe(0);
    expect(res.reasoning).toMatch(/Parse error/);
  });
});

describe("AnthropicProvider.propose (#204)", () => {
  beforeEach(() => {
    create.mockReset();
    vi.mocked(log.warn).mockReset();
  });

  it("returns the model's revised prompt with usage", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "IMPROVED PROMPT:\nBe terser." }],
      usage: { input_tokens: 30, output_tokens: 12 },
    });
    const provider = new AnthropicProvider({ apiKey: "k", reflectModel: "claude-sonnet-4-6" });

    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });

    expect(res.prompt).toContain("Be terser.");
    expect(res.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      model: "claude-sonnet-4-6",
    });
  });

  it("throws when the model returns no usable prompt (keeps the parent prompt)", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "   " }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({ apiKey: "k" });
    await expect(
      provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] })
    ).rejects.toThrow(/empty prompt/);
  });

  it("falls back to the default reflect model and warns on an unrecognized override", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({ apiKey: "k", reflectModel: "claude-bogus-9000" });

    await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });

    expect(log.warn).toHaveBeenCalledWith(
      "Unknown reflect model; falling back to default",
      expect.objectContaining({
        event: "optimization_run.reflect_model_fallback",
        requested: "claude-bogus-9000",
      })
    );
    const [callArgs] = create.mock.calls[0];
    // Falls back to the default reflect model rather than calling the bogus one.
    expect(callArgs.model).not.toBe("claude-bogus-9000");
  });

  it("uses a recognized reflect-model override without warning", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "y" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({ apiKey: "k", reflectModel: "claude-haiku-4-5-20251001" });

    await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });

    expect(log.warn).not.toHaveBeenCalled();
    const [callArgs] = create.mock.calls[0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
  });

  it("throws (empty prompt) when the reply has no content blocks at all", async () => {
    create.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    const provider = new AnthropicProvider({ apiKey: "k" });
    await expect(
      provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] })
    ).rejects.toThrow(/empty prompt/);
  });
});

describe("AnthropicProvider usage folding — no cache/usage fields reported", () => {
  beforeEach(() => create.mockReset());

  it("defaults every usage field to 0 when the SDK reports no usage object at all", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "hi" }] });
    const provider = new AnthropicProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "claude-haiku-4-5-20251001", system: "S", user: "U" });
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: "claude-haiku-4-5-20251001" });
  });
});

describe("AnthropicProvider constructor apiKey fallback", () => {
  const ORIGINAL = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => clientCtor.mockClear());
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL;
  });

  it("falls back to the platform ANTHROPIC_API_KEY env when no key is passed", () => {
    process.env.ANTHROPIC_API_KEY = "env-platform-key";
    new AnthropicProvider();
    expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "env-platform-key" }));
  });

  it("prefers an explicit apiKey over the env", () => {
    process.env.ANTHROPIC_API_KEY = "env-platform-key";
    new AnthropicProvider({ apiKey: "explicit-key" });
    expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "explicit-key" }));
  });
});
