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

  it("judge sends the shared judge max_completion_tokens default (#436)", async () => {
    const provider = new OpenAIProvider({ apiKey: "k", judgeModel: "gpt-5-mini" });
    await provider.judge("You are a judge.", "Score this.");
    const [, init] = fetchSpy.mock.calls[0];
    const parsed = init as { body: string };
    expect(JSON.parse(parsed.body)).toMatchObject({ max_completion_tokens: 4096 });
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

  it("propose accepts an unlisted reflect model when the run's stored provider vouched for it (#485)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("Improved prompt text")),
    });
    // A live-listed OpenAI model the registry doesn't know yet, on a run whose reflect_provider
    // was validated at creation — the registry-membership fallback must not replace it.
    const provider = new OpenAIProvider({
      apiKey: "k",
      reflectModel: "gpt-5.3-preview",
      allowUnlistedReflectModel: true,
    });
    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(res.usage?.model).toBe("gpt-5.3-preview");
  });

  it("propose still falls back on a registry model of ANOTHER provider, even with allowUnlistedReflectModel (#485)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("Improved prompt text")),
    });
    // claude-sonnet-4-6 is a KNOWN Anthropic model — a definite misroute, not a new model.
    const provider = new OpenAIProvider({
      apiKey: "k",
      reflectModel: "claude-sonnet-4-6",
      allowUnlistedReflectModel: true,
    });
    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(res.usage?.model).not.toBe("claude-sonnet-4-6");
  });

  it("propose falls back on an unlisted reflect model WITHOUT the flag (pre-#485 rows, byte-for-byte)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("Improved prompt text")),
    });
    const provider = new OpenAIProvider({ apiKey: "k", reflectModel: "gpt-5.3-preview" });
    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(res.usage?.model).not.toBe("gpt-5.3-preview");
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

describe("OpenAIProvider no-opts construction", () => {
  const ORIGINAL = process.env.OPENAI_API_KEY;
  beforeEach(() => delete process.env.OPENAI_API_KEY);
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL;
  });

  it("throws when constructed with no opts object and no env key (both fallbacks exhausted)", () => {
    expect(() => new OpenAIProvider()).toThrow(/OpenAI API key is required/);
  });
});

describe("OpenAIProvider parseResponse defaults", () => {
  it("defaults text and usage when the response has no choices/usage at all", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new OpenAIProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "gpt-5-mini", system: "S", user: "U" });
    expect(res.text).toBe("");
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: "gpt-5-mini" });
    vi.unstubAllGlobals();
  });
});

describe("OpenAIProvider env key fallback", () => {
  const ORIGINAL = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL;
  });

  it("falls back to the platform OPENAI_API_KEY env when no key is passed", async () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    const fetchSpy = mockFetch(completion("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new OpenAIProvider();
    await provider.complete({ model: "gpt-5-mini", system: "S", user: "U" });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer env-openai-key",
    );
    vi.unstubAllGlobals();
  });
});
