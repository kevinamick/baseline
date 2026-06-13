import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderKey } from "./resolve-key.js";

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
