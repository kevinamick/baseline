import { describe, it, expect, vi, beforeEach } from "vitest";

// AnthropicProvider.complete (#290) is the Managed Agent invocation path: system + single user
// turn → text output + priced usage. Mock the SDK so this is a self-contained unit (no network);
// host pinning (#222) is asserted in managed-key-isolation.test.ts.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { AnthropicProvider } from "./anthropic.js";

describe("AnthropicProvider.complete (#290)", () => {
  beforeEach(() => create.mockReset());

  it("sends system + user and returns text with cache-folded input usage", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "managed reply" }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    });
    const provider = new AnthropicProvider({ apiKey: "k" });

    const res = await provider.complete({
      model: "claude-haiku-4-5-20251001",
      system: "You are terse.",
      user: "What is your refund policy?",
    });

    expect(res.text).toBe("managed reply");
    // cache-read tokens still cost input, so they fold into inputTokens (usageOf).
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5, model: "claude-haiku-4-5-20251001" });
    expect(create).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "You are terse.",
      messages: [{ role: "user", content: "What is your refund policy?" }],
    });
  });

  it("returns empty text when the model yields no text block", async () => {
    create.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    const provider = new AnthropicProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "claude-haiku-4-5-20251001", system: "S", user: "U" });
    expect(res.text).toBe("");
  });
});
