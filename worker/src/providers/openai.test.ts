import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "./openai.js";

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// OpenAI client (#204): the fetch-based Chat Completions adapter. Stub global fetch so this is a
// self-contained unit (no network); host pinning (#222) is asserted by the URL the client calls.
function mockFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(typeof payload === "string" ? payload : JSON.stringify(payload)),
  });
}

const completion = (content: string, prompt = 10, output = 5) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: prompt, completion_tokens: output },
});

describe("OpenAIProvider (#204)", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;
  beforeEach(() => {
    fetchSpy = mockFetch(completion('{"score": 0.8, "reasoning": "good"}'));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("calls the fixed OpenAI host with the bearer key (host pinning, #222)", async () => {
    const provider = new OpenAIProvider({ apiKey: "sk-openai" });
    await provider.complete({ model: "gpt-5-mini", system: "S", user: "U" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(new URL(url as string).hostname).toBe("api.openai.com");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer sk-openai");
  });

  it("judge parses the JSON verdict and reports token usage", async () => {
    const provider = new OpenAIProvider({ apiKey: "k", judgeModel: "gpt-5-mini" });
    const res = await provider.judge("You are a judge.", "Score this.");
    expect(res.score).toBe(0.8);
    expect(res.reasoning).toBe("good");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, model: "gpt-5-mini" });
  });

  it("judge falls back to score 0 on unparseable text but still reports usage", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("not json at all")),
    });
    const provider = new OpenAIProvider({ apiKey: "k", judgeModel: "gpt-5-mini" });
    const res = await provider.judge("S", "U");
    expect(res.score).toBe(0);
    expect(res.usage?.model).toBe("gpt-5-mini");
  });

  it("propose returns the model's revised prompt with usage", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("Improved prompt text")),
    });
    const provider = new OpenAIProvider({ apiKey: "k", reflectModel: "gpt-5" });
    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(res.prompt).toBe("Improved prompt text");
    expect(res.usage?.model).toBe("gpt-5");
  });

  it("propose throws when the model returns an empty prompt", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("   ")),
    });
    const provider = new OpenAIProvider({ apiKey: "k" });
    await expect(
      provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] }),
    ).rejects.toThrow(/empty prompt/);
  });

  it("throws a ProviderHttpError on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("bad key") });
    const provider = new OpenAIProvider({ apiKey: "k" });
    await expect(provider.complete({ model: "gpt-5", system: "S", user: "U" })).rejects.toThrow(
      /openai API returned HTTP 401/,
    );
  });

  it("throws at construction when no API key is provided", () => {
    expect(() => new OpenAIProvider({ apiKey: "" })).toThrow(/OpenAI API key is required/);
  });
});
