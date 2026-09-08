import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderKey, resolveEvalJudge, envProviderKey } from "./resolve-key.js";

// Precedence (ADR-0020): a usable saved key ("byo") → the operator's env var ("env") → none.

const ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY"];
const saved: Record<string, string | undefined> = {};

// A supabase stub: `rows` answers the single-provider row read, `list` the batched .in() read,
// `secrets` the get_provider_secret RPC keyed by secret id.
function makeSupabase(opts: {
  row?: { secret_id: string | null } | null;
  rowError?: { message: string } | null;
  list?: { provider: string; secret_id: string | null }[];
  listError?: { message: string } | null;
  secrets?: Record<string, string | null>;
  secretError?: { message: string } | null;
}): SupabaseClient {
  const builder: Record<string, unknown> = {};
  for (const k of ["select", "eq"]) builder[k] = () => builder;
  builder.in = () => Promise.resolve({ data: opts.list ?? [], error: opts.listError ?? null });
  builder.maybeSingle = () => Promise.resolve({ data: opts.row ?? null, error: opts.rowError ?? null });
  return {
    from: () => builder,
    rpc: (_fn: string, args: { p_secret_id: string }) =>
      Promise.resolve({
        data: opts.secretError ? null : (opts.secrets?.[args.p_secret_id] ?? null),
        error: opts.secretError ?? null,
      }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  for (const k of ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("envProviderKey", () => {
  it("reads the provider's env var, treating blank as unset", () => {
    process.env.OPENAI_API_KEY = "  ";
    expect(envProviderKey("openai")).toBeNull();
    process.env.OPENAI_API_KEY = " sk-env ";
    expect(envProviderKey("openai")).toBe("sk-env");
  });
});

describe("resolveProviderKey (ADR-0020)", () => {
  it("uses the saved Vault key when one is stored and usable, even with an env key set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    const supabase = makeSupabase({ row: { secret_id: "s1" }, secrets: { s1: " sk-vault " } });
    expect(await resolveProviderKey(supabase, "org", "anthropic")).toEqual({ source: "byo", key: "sk-vault" });
  });

  it("falls back to the env var when there is no row", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    const supabase = makeSupabase({ row: null });
    expect(await resolveProviderKey(supabase, "org", "anthropic")).toEqual({ source: "env", key: "sk-env" });
  });

  it("falls back to the env var when the stored secret is blank", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    const supabase = makeSupabase({ row: { secret_id: "s1" }, secrets: { s1: "   " } });
    expect(await resolveProviderKey(supabase, "org", "openai")).toEqual({ source: "env", key: "sk-env" });
  });

  it("returns none with neither a saved key nor an env var", async () => {
    const supabase = makeSupabase({ row: null });
    expect(await resolveProviderKey(supabase, "org", "google")).toEqual({ source: "none" });
  });

  it("throws when the provider_keys read fails", async () => {
    const supabase = makeSupabase({ rowError: { message: "db down" } });
    await expect(resolveProviderKey(supabase, "org", "anthropic")).rejects.toThrow("Failed to read provider key: db down");
  });

  it("throws when the get_provider_secret RPC fails", async () => {
    const supabase = makeSupabase({ row: { secret_id: "s1" }, secretError: { message: "vault down" } });
    await expect(resolveProviderKey(supabase, "org", "anthropic")).rejects.toThrow("Failed to read provider key: vault down");
  });
});

describe("resolveEvalJudge (#204, #371, ADR-0020)", () => {
  it("judges on the provider with a saved key — a Workspace with only an OpenAI key judges on OpenAI", async () => {
    const supabase = makeSupabase({ list: [{ provider: "openai", secret_id: "o" }], secrets: { o: "sk-o" } });
    const r = await resolveEvalJudge(supabase, "org");
    expect(r.provider).toBe("openai");
    expect(r.resolved).toEqual({ source: "byo", key: "sk-o" });
  });

  it("prefers Anthropic when several saved keys exist (deterministic, judge-tuned default)", async () => {
    const supabase = makeSupabase({
      list: [
        { provider: "openai", secret_id: "o" },
        { provider: "anthropic", secret_id: "a" },
      ],
      secrets: { o: "sk-o", a: "sk-a" },
    });
    expect((await resolveEvalJudge(supabase, "org")).provider).toBe("anthropic");
  });

  it("falls through a blank Anthropic secret to a usable OpenAI key rather than giving up (#371)", async () => {
    const supabase = makeSupabase({
      list: [
        { provider: "anthropic", secret_id: "a" },
        { provider: "openai", secret_id: "o" },
      ],
      secrets: { a: "  ", o: "sk-o" },
    });
    expect((await resolveEvalJudge(supabase, "org")).provider).toBe("openai");
  });

  it("falls back to the first provider with an env key when no saved key is usable", async () => {
    process.env.GOOGLE_API_KEY = "sk-g";
    const supabase = makeSupabase({ list: [] });
    const r = await resolveEvalJudge(supabase, "org");
    expect(r.provider).toBe("google");
    expect(r.resolved).toEqual({ source: "env", key: "sk-g" });
  });

  it("returns none when neither a saved key nor an env key exists (the app gate refuses it earlier)", async () => {
    const supabase = makeSupabase({ list: [] });
    const r = await resolveEvalJudge(supabase, "org");
    expect(r.provider).toBe("anthropic");
    expect(r.resolved).toEqual({ source: "none" });
  });

  it("treats a candidate whose secret RPC errors as unusable rather than throwing the whole lookup", async () => {
    process.env.MISTRAL_API_KEY = "sk-m";
    const supabase = makeSupabase({ list: [{ provider: "anthropic", secret_id: "a" }], secretError: { message: "vault blip" } });
    const r = await resolveEvalJudge(supabase, "org");
    expect(r.provider).toBe("mistral");
    expect(r.resolved).toEqual({ source: "env", key: "sk-m" });
  });

  it("throws when the saved-key discovery query (.in()) fails", async () => {
    const supabase = makeSupabase({ listError: { message: "db down" } });
    await expect(resolveEvalJudge(supabase, "org")).rejects.toThrow("Failed to read provider keys: db down");
  });
});
