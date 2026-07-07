import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MistralProvider } from "./mistral.js";

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Mistral client (#204, provider #3): the fetch-based chat-completions adapter. Stub global fetch
// so this is a self-contained unit (no network); host pinning (#222) is asserted by the URL.
const completion = (content: string, prompt = 11, output = 6) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: prompt, completion_tokens: output },
});

describe("MistralProvider (#204)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion('{"score": 0.7, "reasoning": "solid"}')),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("calls the fixed Mistral host with the bearer key and max_tokens (host pinning, #222)", async () => {
    const provider = new MistralProvider({ apiKey: "mistral-secret" });
    await provider.complete({ model: "mistral-small-latest", system: "S", user: "U" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(new URL(url as string).hostname).toBe("api.mistral.ai");
    const parsed = init as { headers: Record<string, string>; body: string };
    expect(parsed.headers.authorization).toBe("Bearer mistral-secret");
    // Mistral uses max_tokens (not OpenAI's max_completion_tokens); complete() uses the shared
    // fetch-client ceiling that gives reasoning models headroom (#204).
    expect(JSON.parse(parsed.body)).toMatchObject({ max_tokens: 4096 });
  });

  it("judge parses the JSON verdict and reports token usage", async () => {
    const provider = new MistralProvider({ apiKey: "k", judgeModel: "mistral-small-latest" });
    const res = await provider.judge("You are a judge.", "Score this.");
    expect(res.score).toBe(0.7);
    expect(res.reasoning).toBe("solid");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 6, model: "mistral-small-latest" });
  });

  it("judge sends the shared judge max_tokens default (#436)", async () => {
    const provider = new MistralProvider({ apiKey: "k", judgeModel: "mistral-small-latest" });
    await provider.judge("You are a judge.", "Score this.");
    const [, init] = fetchSpy.mock.calls[0];
    const parsed = init as { body: string };
    expect(JSON.parse(parsed.body)).toMatchObject({ max_tokens: 4096 });
  });

  it("propose returns the model's revised prompt with usage", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("Improved prompt text")),
    });
    const provider = new MistralProvider({ apiKey: "k", reflectModel: "mistral-large-latest" });
    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(res.prompt).toBe("Improved prompt text");
    expect(res.usage?.model).toBe("mistral-large-latest");
  });

  it("falls back to the default reflect model for an unknown one", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("x")),
    });
    const provider = new MistralProvider({ apiKey: "k", reflectModel: "mistral-bogus" });
    const res = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(res.usage?.model).toBe("mistral-large-latest");
  });

  it("throws a ProviderHttpError on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("bad key") });
    const provider = new MistralProvider({ apiKey: "k" });
    await expect(
      provider.complete({ model: "mistral-large-latest", system: "S", user: "U" }),
    ).rejects.toThrow(/mistral API returned HTTP 401/);
  });

  it("throws at construction when no API key is provided", () => {
    expect(() => new MistralProvider({ apiKey: "" })).toThrow(/Mistral API key is required/);
  });
});

describe("MistralProvider parseResponse defaults", () => {
  it("defaults text and usage when the response has no choices/usage at all", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new MistralProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "mistral-small-latest", system: "S", user: "U" });
    expect(res.text).toBe("");
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: "mistral-small-latest" });
    vi.unstubAllGlobals();
  });
});

describe("MistralProvider env key fallback", () => {
  const ORIGINAL = process.env.MISTRAL_API_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = ORIGINAL;
  });

  it("falls back to the platform MISTRAL_API_KEY env when no key is passed", async () => {
    process.env.MISTRAL_API_KEY = "env-mistral-key";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(completion("ok")),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new MistralProvider();
    await provider.complete({ model: "mistral-small-latest", system: "S", user: "U" });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer env-mistral-key",
    );
    vi.unstubAllGlobals();
  });
});
