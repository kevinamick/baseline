import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderKey } from "./resolve-key.js";
import { AnthropicProvider } from "./anthropic.js";

// Managed-key host isolation (#222, acceptance criterion 3).
//
// The live SSRF test showed a managed/shared credential must NEVER be routable to a
// tenant-controlled endpoint. The guarantee here is architectural, and these tests pin it:
//
//   - The managed platform key is resolved by resolveProviderKey (#184) and consumed ONLY by
//     the LLM provider SDK, which targets a FIXED provider host (api.anthropic.com). The SDK is
//     never pointed at a Connection's `endpoint`, and we never expose a base-URL override that a
//     tenant could set, so the managed key can only ever leave our infra to the real provider.
//
//   - The credential routed to tenant endpoints is a different secret entirely: the Connection's
//     own `auth_secret_id` (decrypted via get_connection_auth in worker.ts and passed as
//     `authValue` to invokeAgent / the adapters). It is sourced and typed separately from the
//     managed provider key, so there is no code path that splices a managed key into a
//     tenant-bound request.

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

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

describe("managed key host isolation (#222)", () => {
  const ORIGINAL_ENV = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "managed-platform-key";
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV;
  });

  it("routes a resolved managed key only to the fixed Anthropic provider host", async () => {
    // A paid Team with no BYO key resolves to the managed platform key.
    const supabase = makeSupabase({ providerKeyRow: null, customer: { status: "active" } });
    const resolved = await resolveProviderKey(supabase as never, "org_1", "anthropic");
    expect(resolved).toEqual({ source: "managed", key: "managed-platform-key" });
    if (resolved.source !== "managed") throw new Error("expected a managed key");

    // That managed key is handed to the provider SDK, whose base URL is the fixed Anthropic
    // host — NOT a tenant-supplied endpoint. A managed-key call can therefore only ever target
    // the real provider, never an attacker-controlled URL.
    const provider = new AnthropicProvider({ apiKey: resolved.key });
    const client = (provider as unknown as { client: { baseURL: string } }).client;
    expect(new URL(client.baseURL).hostname).toBe("api.anthropic.com");
  });

  it("does not let an environment base-URL override redirect the managed key off the provider host", () => {
    // Defense-in-depth: even if the worker env carried a stray ANTHROPIC_BASE_URL, the provider
    // is constructed without honoring it, so the managed key stays pinned to api.anthropic.com.
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://attacker.example.com");
    const provider = new AnthropicProvider({ apiKey: "managed-platform-key" });
    const client = (provider as unknown as { client: { baseURL: string } }).client;
    expect(new URL(client.baseURL).hostname).toBe("api.anthropic.com");
    vi.unstubAllEnvs();
  });
});
