import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderKey } from "./resolve-key.js";
import { createProviderForModel } from "./factory.js";
import { defaultJudgeModelForProvider, providerForModel } from "./models.js";
import { OpenAIProvider } from "./openai.js";

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Integration (#204, acceptance criterion 1): a Team's stored OpenAI key, resolved exactly as a
// run would resolve it, drives a real judge + reflection call through the factory-selected client.
// This is the worker-side proof that a non-Anthropic key drives a run (the app/e2e prove the rest).
function makeSupabase(opts: { providerKeyRow?: { secret_id: string } | null; secret?: string | null }) {
  const tables: Record<string, unknown> = {
    provider_keys: opts.providerKeyRow ?? null,
    customers: null,
  };
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq"]) chain[k] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: tables[table] ?? null, error: null });
      return chain;
    },
    rpc(fn: string) {
      if (fn === "get_provider_secret")
        return Promise.resolve({ data: opts.secret ?? null, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

describe("non-Anthropic key drives a run (#204)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the Team's OpenAI BYO key and runs a judge + reflection through the OpenAI client", async () => {
    const supabase = makeSupabase({ providerKeyRow: { secret_id: "sec_1" }, secret: "sk-openai-byo" });

    // A run with an OpenAI reflect model resolves OpenAI as the run provider — judge included.
    const reflectModel = "gpt-5";
    const judgeModel = defaultJudgeModelForProvider(providerForModel(reflectModel));
    expect(providerForModel(reflectModel)).toBe("openai");
    expect(providerForModel(judgeModel)).toBe("openai");

    // Key resolution returns the Team's own OpenAI key — the same precedence a live run uses.
    const resolved = await resolveProviderKey(supabase as never, "org_1", providerForModel(judgeModel));
    expect(resolved).toEqual({ source: "byo", key: "sk-openai-byo" });
    if (resolved.source === "none") throw new Error("expected a key");

    // The factory picks the OpenAI client for the judge model and pins the judge model.
    const provider = createProviderForModel(judgeModel, { apiKey: resolved.key, judgeModel, reflectModel });
    expect(provider).toBeInstanceOf(OpenAIProvider);

    // Judge call.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"score": 0.9, "reasoning": "great"}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
    });
    const verdict = await provider.judge("You are a judge.", "Score this answer.");
    expect(verdict.score).toBe(0.9);
    expect(verdict.usage).toEqual({ inputTokens: 20, outputTokens: 8, model: judgeModel });

    // Reflection call.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "A sharper prompt." } }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        }),
    });
    const proposal = await provider.propose({ targetModule: "system", currentPrompt: "old", examples: [] });
    expect(proposal.prompt).toBe("A sharper prompt.");
    expect(proposal.usage).toEqual({ inputTokens: 30, outputTokens: 12, model: reflectModel });

    // Both calls left for the real OpenAI host carrying the Team's key — never Anthropic.
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(new URL(url as string).hostname).toBe("api.openai.com");
      expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer sk-openai-byo");
    }
  });
});
