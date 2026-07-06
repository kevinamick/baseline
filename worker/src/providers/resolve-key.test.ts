import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderKey, resolveEvalJudge } from "./resolve-key.js";
import { defaultJudgeModelForProvider } from "./registry.js";

vi.mock("../log.js", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// A minimal Supabase stub: from(table) returns a chain whose maybeSingle resolves
// from a per-table queue; rpc resolves from a per-fn map. Only the calls
// resolveProviderKey makes are modelled.
function makeSupabase(opts: {
  providerKeyRow?: { secret_id: string } | null;
  secret?: string | null;
  customer?: { status: string } | null;
}) {
  const tables: Record<string, unknown> = {
    provider_keys: opts.providerKeyRow ?? null,
    customers: opts.customer ?? null,
  };
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq"]) chain[k] = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve({ data: tables[table] ?? null, error: null });
      return chain;
    },
    rpc(fn: string) {
      if (fn === "get_provider_secret")
        return Promise.resolve({ data: opts.secret ?? null, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

describe("resolveProviderKey (#184)", () => {
  const ORIGINAL_ENV = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "managed-platform-key";
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV;
  });

  it("uses the Team's BYO key when one is stored (any plan)", async () => {
    const supabase = makeSupabase({
      providerKeyRow: { secret_id: "sec_1" },
      secret: "sk-byo-123",
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result).toEqual({ source: "byo", key: "sk-byo-123" });
  });

  it("falls back to the managed platform key for a paid Team with no BYO key", async () => {
    const supabase = makeSupabase({
      providerKeyRow: null,
      customer: { status: "active" },
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result).toEqual({ source: "managed", key: "managed-platform-key" });
  });

  it("treats a trialing subscription as paid (managed fallback)", async () => {
    const supabase = makeSupabase({
      providerKeyRow: null,
      customer: { status: "trialing" },
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result.source).toBe("managed");
  });

  it("returns none for a Free Team with no BYO key (no customers row)", async () => {
    const supabase = makeSupabase({ providerKeyRow: null, customer: null });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result).toEqual({ source: "none" });
  });

  it("returns none for a lapsed/past_due paid sub with no BYO key (fail closed)", async () => {
    const supabase = makeSupabase({
      providerKeyRow: null,
      customer: { status: "past_due" },
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result).toEqual({ source: "none" });
  });

  it("returns none when a paid Team's provider has no managed key configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const supabase = makeSupabase({
      providerKeyRow: null,
      customer: { status: "active" },
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result).toEqual({ source: "none" });
  });

  it("Free invariant: never returns the managed key for a Free Team, even with one configured (ADR-0008)", async () => {
    // The managed Anthropic key is present in the worker env (set in beforeEach), but a Free Team
    // (no customers row) must NEVER reach it — it resolves to "none" and the run fails closed.
    const supabase = makeSupabase({ providerKeyRow: null, customer: null });
    const result = await resolveProviderKey(
      supabase as never,
      "org_free",
      "anthropic",
    );
    expect(result).toEqual({ source: "none" });
    expect(result).not.toHaveProperty("key");
  });

  it("Free invariant: an empty/whitespace BYO secret on a Free Team resolves to none, not managed", async () => {
    // A Free Team with a stored-but-empty BYO secret must still fail closed — the empty secret is
    // ignored (not BYO) and there is no paid status to grant the managed fallback.
    const supabase = makeSupabase({
      providerKeyRow: { secret_id: "sec_1" },
      secret: "   ",
      customer: null,
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_free",
      "anthropic",
    );
    expect(result).toEqual({ source: "none" });
  });

  it("throws when the provider_keys read fails", async () => {
    const supabase = {
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const k of ["select", "eq"]) chain[k] = () => chain;
        chain.maybeSingle = () =>
          Promise.resolve({ data: null, error: { message: "provider_keys read blew up" } });
        return chain;
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
    await expect(
      resolveProviderKey(supabase as never, "org_1", "anthropic"),
    ).rejects.toThrow("Failed to read provider key: provider_keys read blew up");
  });

  it("throws when the get_provider_secret RPC fails", async () => {
    const supabase = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        for (const k of ["select", "eq"]) chain[k] = () => chain;
        chain.maybeSingle = () =>
          Promise.resolve({
            data: table === "provider_keys" ? { secret_id: "sec_1" } : null,
            error: null,
          });
        return chain;
      },
      rpc: () => Promise.resolve({ data: null, error: { message: "vault decrypt failed" } }),
    };
    await expect(
      resolveProviderKey(supabase as never, "org_1", "anthropic"),
    ).rejects.toThrow("Failed to read provider key: vault decrypt failed");
  });

  it("throws when the customers (billing status) read fails", async () => {
    const supabase = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        for (const k of ["select", "eq"]) chain[k] = () => chain;
        chain.maybeSingle = () =>
          Promise.resolve(
            table === "customers"
              ? { data: null, error: { message: "customers read blew up" } }
              : { data: null, error: null },
          );
        return chain;
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
    await expect(
      resolveProviderKey(supabase as never, "org_1", "anthropic"),
    ).rejects.toThrow("Failed to read billing status: customers read blew up");
  });

  it("ignores an empty stored secret and falls through to managed", async () => {
    const supabase = makeSupabase({
      providerKeyRow: { secret_id: "sec_1" },
      secret: "   ",
      customer: { status: "active" },
    });
    const result = await resolveProviderKey(
      supabase as never,
      "org_1",
      "anthropic",
    );
    expect(result).toEqual({ source: "managed", key: "managed-platform-key" });
  });
});

// resolveEvalJudge (#204, #371): an eval run has no per-run model, so the judge provider is
// discovered from the Team's keys — the first RUNTIME_READY_PROVIDERS-order provider with a
// USABLE key wins (Team pays), falling through past a provider whose row exists but whose secret
// is empty/whitespace rather than stopping there; no usable key at all falls to managed Anthropic
// (paid) or none (Free).
//
// firstUsableByoProvider does ONE discovery read (`.select("provider, secret_id")...in(...)`),
// then a get_provider_secret RPC per candidate row, walked in RUNTIME_READY_PROVIDERS order. The
// stub models both: `.in()` resolves the discovery rows (provider + secret_id), and `rpc` looks a
// secret up by the p_secret_id argument from a per-provider map, so different rows can carry
// different (or unusable) secrets in the same test.
function makeJudgeSupabase(opts: {
  /** provider -> secret_id for each row the Team has stored (row exists, may still be unusable). */
  rows?: Record<string, string>;
  /** secret_id -> stored secret value (undefined entries error the RPC). */
  secretsBySecretId?: Record<string, string | null>;
  secretRpcError?: { message: string };
  customer?: { status: string } | null;
}) {
  const rows = Object.entries(opts.rows ?? {}).map(([provider, secret_id]) => ({
    provider,
    secret_id,
  }));
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq"]) chain[k] = () => chain;
      // firstUsableByoProvider terminates on .in() and awaits the row array directly.
      chain.in = () => Promise.resolve({ data: rows, error: null });
      // resolveProviderKey's fallback-to-Anthropic path reads a single provider_keys row, then
      // the customers row, when firstUsableByoProvider found nothing.
      chain.maybeSingle = () =>
        Promise.resolve({
          data: table === "customers" ? (opts.customer ?? null) : null,
          error: null,
        });
      return chain;
    },
    rpc(fn: string, args: { p_secret_id: string }) {
      if (fn !== "get_provider_secret") return Promise.resolve({ data: null, error: null });
      if (opts.secretRpcError) return Promise.resolve({ data: null, error: opts.secretRpcError });
      const value = opts.secretsBySecretId?.[args.p_secret_id];
      return Promise.resolve({ data: value ?? null, error: null });
    },
  };
}

describe("resolveEvalJudge (#204, #371)", () => {
  const ORIGINAL_ENV = process.env.ANTHROPIC_API_KEY;
  const ORIGINAL_OPENAI_ENV = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "managed-platform-key";
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV;
    if (ORIGINAL_OPENAI_ENV === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_ENV;
  });

  it("judges on the Team's BYO provider — a Free Team with only an OpenAI key judges on OpenAI", async () => {
    const supabase = makeJudgeSupabase({
      rows: { openai: "sec_openai" },
      secretsBySecretId: { sec_openai: "sk-openai-byo" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("openai");
    expect(result.judgeModel).toBe(defaultJudgeModelForProvider("openai"));
    expect(result.resolved).toEqual({ source: "byo", key: "sk-openai-byo" });
  });

  it("prefers Anthropic when the Team has several usable BYO keys (deterministic, judge-tuned default)", async () => {
    const supabase = makeJudgeSupabase({
      rows: { openai: "sec_openai", anthropic: "sec_anthropic" },
      secretsBySecretId: { sec_openai: "sk-openai-byo", sec_anthropic: "sk-anthropic-byo" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({ source: "byo", key: "sk-anthropic-byo" });
  });

  it("falls back to the managed Anthropic key for a paid Team with no BYO key", async () => {
    const supabase = makeJudgeSupabase({
      rows: {},
      customer: { status: "active" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({
      source: "managed",
      key: "managed-platform-key",
    });
  });

  it("returns none for a Free Team with no BYO key (the app gate refuses it earlier)", async () => {
    const supabase = makeJudgeSupabase({ rows: {}, customer: null });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({ source: "none" });
  });

  it("throws when the BYO-provider discovery query (.in()) fails", async () => {
    const supabase = {
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const k of ["select", "eq"]) chain[k] = () => chain;
        chain.in = () => Promise.resolve({ data: null, error: { message: "discovery query blew up" } });
        return chain;
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
    await expect(resolveEvalJudge(supabase as never, "org_1")).rejects.toThrow(
      "Failed to read provider keys: discovery query blew up",
    );
  });

  // #371 acceptance scenario: an empty/whitespace-secret Anthropic row sitting alongside a USABLE
  // OpenAI row must judge BYO on OpenAI — not fall through to managed Anthropic. This is the
  // divergence the issue tracked: the OLD firstByoProvider stopped at the first provider with ANY
  // row (Anthropic, since it's first in provider order) and gave up as soon as THAT row's secret
  // proved unusable, ignoring the still-usable OpenAI row entirely.
  it("falls through a blank Anthropic secret to a usable OpenAI key rather than giving up (#371)", async () => {
    const supabase = makeJudgeSupabase({
      rows: { anthropic: "sec_anthropic_blank", openai: "sec_openai_usable" },
      secretsBySecretId: { sec_anthropic_blank: "   ", sec_openai_usable: "sk-openai-byo" },
      customer: { status: "active" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("openai");
    expect(result.judgeModel).toBe(defaultJudgeModelForProvider("openai"));
    expect(result.resolved).toEqual({ source: "byo", key: "sk-openai-byo" });
  });

  it("falls back to Anthropic managed when EVERY row's secret is blank on a paid Team", async () => {
    const supabase = makeJudgeSupabase({
      rows: { anthropic: "sec_anthropic_blank", openai: "sec_openai_blank" },
      secretsBySecretId: { sec_anthropic_blank: "   ", sec_openai_blank: "" },
      customer: { status: "active" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({
      source: "managed",
      key: "managed-platform-key",
    });
  });

  it("treats a candidate whose secret RPC errors as unusable rather than throwing the whole lookup", async () => {
    // secretRpcError makes every get_provider_secret call in this stub error, modelling a
    // transient Vault read failure while scanning candidates. firstUsableByoProvider must not
    // throw here (it would abort a run that could otherwise still resolve to the managed
    // fallback) — it treats the errored candidate as unusable and keeps going, landing on the
    // Anthropic managed/none fallback exactly as if neither row existed.
    const supabase = makeJudgeSupabase({
      rows: { anthropic: "sec_anthropic_err", openai: "sec_openai_err" },
      secretRpcError: { message: "vault transient error" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved.source).toBe("none");
  });
});
