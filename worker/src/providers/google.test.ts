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

  it("throws a ProviderHttpError on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("denied") });
    const provider = new GoogleProvider({ apiKey: "k" });
    await expect(
      provider.complete({ model: "gemini-2.5-flash", system: "S", user: "U" }),
    ).rejects.toThrow(/google API returned HTTP 403/);
  });
});
