import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderKey, resolveEvalJudge } from "./resolve-key.js";
import { defaultJudgeModelForProvider } from "./models.js";

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

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
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result).toEqual({ source: "byo", key: "sk-byo-123" });
  });

  it("falls back to the managed platform key for a paid Team with no BYO key", async () => {
    const supabase = makeSupabase({
      providerKeyRow: null,
      customer: { status: "active" },
    });
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result).toEqual({ source: "managed", key: "managed-platform-key" });
  });

  it("treats a trialing subscription as paid (managed fallback)", async () => {
    const supabase = makeSupabase({ providerKeyRow: null, customer: { status: "trialing" } });
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result.source).toBe("managed");
  });

  it("returns none for a Free Team with no BYO key (no customers row)", async () => {
    const supabase = makeSupabase({ providerKeyRow: null, customer: null });
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result).toEqual({ source: "none" });
  });

  it("returns none for a lapsed/past_due paid sub with no BYO key (fail closed)", async () => {
    const supabase = makeSupabase({ providerKeyRow: null, customer: { status: "past_due" } });
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result).toEqual({ source: "none" });
  });

  it("returns none when a paid Team's provider has no managed key configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const supabase = makeSupabase({ providerKeyRow: null, customer: { status: "active" } });
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result).toEqual({ source: "none" });
  });

  it("Free invariant: never returns the managed key for a Free Team, even with one configured (ADR-0008)", async () => {
    // The managed Anthropic key is present in the worker env (set in beforeEach), but a Free Team
    // (no customers row) must NEVER reach it — it resolves to "none" and the run fails closed.
    const supabase = makeSupabase({ providerKeyRow: null, customer: null });
    const result = await resolveProviderKey(supabase as never, "org_free", "anthropic");
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
    const result = await resolveProviderKey(supabase as never, "org_free", "anthropic");
    expect(result).toEqual({ source: "none" });
  });

  it("ignores an empty stored secret and falls through to managed", async () => {
    const supabase = makeSupabase({
      providerKeyRow: { secret_id: "sec_1" },
      secret: "   ",
      customer: { status: "active" },
    });
    const result = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(result).toEqual({ source: "managed", key: "managed-platform-key" });
  });
});

// resolveEvalJudge (#204): an eval run has no per-run model, so the judge provider is discovered
// from the Team's keys — a BYO key judges on its own provider (Team pays), and no BYO key falls to
// managed Anthropic (paid) or none (Free). Stub: from("provider_keys").select().eq().in() returns
// the BYO provider rows (the discovery query); the .maybeSingle()/.rpc/customers chain serves the
// follow-up resolveProviderKey for the chosen provider.
function makeJudgeSupabase(opts: {
  byoProviders?: string[];
  secret?: string | null;
  customer?: { status: string } | null;
}) {
  const byoRows = (opts.byoProviders ?? []).map((provider) => ({ provider }));
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq"]) chain[k] = () => chain;
      // firstByoProvider terminates on .in() and awaits the row array directly.
      chain.in = () => Promise.resolve({ data: byoRows, error: null });
      // resolveProviderKey reads a single provider_keys row, then the customers row.
      chain.maybeSingle = () =>
        Promise.resolve({
          data:
            table === "customers"
              ? opts.customer ?? null
              : byoRows.length
                ? { secret_id: "sec_judge" }
                : null,
          error: null,
        });
      return chain;
    },
    rpc(fn: string) {
      if (fn === "get_provider_secret")
        return Promise.resolve({ data: opts.secret ?? null, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

describe("resolveEvalJudge (#204)", () => {
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
    const supabase = makeJudgeSupabase({ byoProviders: ["openai"], secret: "sk-openai-byo" });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("openai");
    expect(result.judgeModel).toBe(defaultJudgeModelForProvider("openai"));
    expect(result.resolved).toEqual({ source: "byo", key: "sk-openai-byo" });
  });

  it("prefers Anthropic when the Team has several BYO keys (deterministic, judge-tuned default)", async () => {
    const supabase = makeJudgeSupabase({
      byoProviders: ["openai", "anthropic"],
      secret: "sk-anthropic-byo",
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({ source: "byo", key: "sk-anthropic-byo" });
  });

  it("falls back to the managed Anthropic key for a paid Team with no BYO key", async () => {
    const supabase = makeJudgeSupabase({ byoProviders: [], customer: { status: "active" } });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({ source: "managed", key: "managed-platform-key" });
  });

  it("returns none for a Free Team with no BYO key (the app gate refuses it earlier)", async () => {
    const supabase = makeJudgeSupabase({ byoProviders: [], customer: null });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({ source: "none" });
  });

  it("falls back to Anthropic managed when a non-Anthropic row has an empty secret on a paid Team (never judges managed on a non-Anthropic provider)", async () => {
    process.env.OPENAI_API_KEY = "managed-openai-key";
    const supabase = makeJudgeSupabase({
      byoProviders: ["openai"],
      secret: "   ",
      customer: { status: "active" },
    });
    const result = await resolveEvalJudge(supabase as never, "org_1");
    expect(result.provider).toBe("anthropic");
    expect(result.resolved).toEqual({ source: "managed", key: "managed-platform-key" });
  });
});
