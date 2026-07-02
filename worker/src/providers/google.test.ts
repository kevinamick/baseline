import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleProvider } from "./google.js";

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Google client (#204): the fetch-based generateContent adapter. Stub global fetch so this is a
// self-contained unit (no network); host pinning (#222) is asserted by the URL the client calls.
function gen(text: string, promptTokens = 12, candTokens = 7) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: candTokens },
  };
}

describe("GoogleProvider (#204)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(gen('{"score": 0.5, "reasoning": "ok"}')),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("calls the fixed Google host with the key in a header, never the URL (#222)", async () => {
    const provider = new GoogleProvider({ apiKey: "goog-secret" });
    await provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" });
    const [url, init] = fetchSpy.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.hostname).toBe("generativelanguage.googleapis.com");
    expect(parsed.pathname).toContain("gemini-2.5-flash:generateContent");
    // The key rides the x-goog-api-key header, so it never lands in a logged URL.
    expect(url).not.toContain("goog-secret");
    expect((init as { headers: Record<string, string> }).headers["x-goog-api-key"]).toBe("goog-secret");
  });

  it("honors GOOGLE_API_BASE_OVERRIDE for local dev/testing (operator-only escape hatch)", async () => {
    // The override is read at module load, so import a fresh module copy with the env set.
    vi.resetModules();
    vi.stubEnv("GOOGLE_API_BASE_OVERRIDE", "http://127.0.0.1:8899/v1beta/models");
    const { GoogleProvider: FreshGoogleProvider } = await import("./google.js");
    const provider = new FreshGoogleProvider({ apiKey: "k" });
    await provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" });
    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).toBe("8899");
    expect(parsed.pathname).toContain("gemini-2.5-flash:generateContent");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("judge parses the JSON verdict and reports token usage", async () => {
    const provider = new GoogleProvider({ apiKey: "k", judgeModel: "gemini-2.5-flash" });
    const res = await provider.judge("You are a judge.", "Score this.");
    expect(res.score).toBe(0.5);
    expect(res.reasoning).toBe("ok");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7, model: "gemini-2.5-flash" });
  });

  it("complete concatenates multi-part text output", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [{ content: { parts: [{ text: "part-a " }, { text: "part-b" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
        }),
    });
    const provider = new GoogleProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "gemini-2.5-pro", system: "S", user: "U" });
    expect(res.text).toBe("part-a part-b");
    expect(res.usage.model).toBe("gemini-2.5-pro");
  });

  it("counts Gemini thinking tokens as output so managed metering isn't under-counted (#204)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, thoughtsTokenCount: 100 },
        }),
    });
    const provider = new GoogleProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "gemini-2.5-pro", system: "S", user: "U" });
    // 8 visible + 100 thinking are both billed as output.
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 108, model: "gemini-2.5-pro" });
  });

  it("throws a ProviderHttpError on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("denied") });
    const provider = new GoogleProvider({ apiKey: "k" });
    await expect(
      provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" }),
    ).rejects.toThrow(/google API returned HTTP 403/);
  });

  it("throws at construction when no API key is provided", () => {
    expect(() => new GoogleProvider({ apiKey: "" })).toThrow(/Google API key is required/);
  });
});

describe("GoogleProvider parseResponse defaults", () => {
  it("defaults text and usage when the response has no candidates/usageMetadata at all", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new GoogleProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" });
    expect(res.text).toBe("");
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: "gemini-2.5-flash" });
    vi.unstubAllGlobals();
  });

  it("defaults a part's missing text to empty string when concatenating", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [{ content: { parts: [{}, { text: "b" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new GoogleProvider({ apiKey: "k" });
    const res = await provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" });
    expect(res.text).toBe("b");
    vi.unstubAllGlobals();
  });
});

describe("GoogleProvider env key fallback", () => {
  const ORIGINAL = process.env.GOOGLE_API_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = ORIGINAL;
  });

  it("falls back to the platform GOOGLE_API_KEY env when no key is passed", async () => {
    process.env.GOOGLE_API_KEY = "env-google-key";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(gen("ok")),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new GoogleProvider();
    await provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers["x-goog-api-key"]).toBe(
      "env-google-key",
    );
    vi.unstubAllGlobals();
  });
});
