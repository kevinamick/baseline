import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced by the (hoisted) vi.mock factories, which run before
// plain const initializers when the subject is statically imported.
const { mockMaybeSingle, mockKeysList, mockRpc } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockKeysList: vi.fn(),
  mockRpc: vi.fn(),
}));

// supabaseAdmin chain. resolveKeySource terminates on .maybeSingle() (via
// readUsableProviderSecret); the batched resolveKeySources awaits the builder
// itself after .in(), so the builder is also a thenable backed by mockKeysList.
vi.mock("@/lib/supabase/admin", () => {
  const builder: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "limit"]) builder[k] = () => builder;
  builder.maybeSingle = mockMaybeSingle;
  builder.then = (resolve: (v: unknown) => unknown) => resolve(mockKeysList());
  return { supabaseAdmin: { from: () => builder, rpc: mockRpc } };
});

import {
  KEY_SOURCE,
  envProviderKey,
  evalRunBlockedForMissingKey,
  hasRuntimeProviderKey,
  countUsableProviders,
  resolveKeySource,
  resolveKeySources,
  missingKeyError,
} from "@/lib/llm/key-gate";

const ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockKeysList.mockReturnValue({ data: [], error: null });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockRpc.mockResolvedValue({ data: "sk-usable", error: null });
});
afterEach(() => {
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("envProviderKey (ADR-0020)", () => {
  it("reads the provider's env var, treating blank as unset", () => {
    process.env.OPENAI_API_KEY = "   ";
    expect(envProviderKey("openai")).toBeNull();
    process.env.OPENAI_API_KEY = " sk-env ";
    expect(envProviderKey("openai")).toBe("sk-env");
    expect(envProviderKey("anthropic")).toBeNull();
  });
});

describe("resolveKeySource", () => {
  it("prefers a usable Vault key over the env var", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec-1" }, error: null });
    expect(await resolveKeySource("org", "anthropic")).toBe(KEY_SOURCE.vault);
  });

  it("falls back to the env var when the Vault secret is blank", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec-1" }, error: null });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    expect(await resolveKeySource("org", "anthropic")).toBe(KEY_SOURCE.env);
  });

  it("is none with neither a Vault row nor an env var", async () => {
    expect(await resolveKeySource("org", "anthropic")).toBe(KEY_SOURCE.none);
  });
});

describe("resolveKeySources (batched)", () => {
  it("maps each provider independently and fails closed on an unreadable secret", async () => {
    process.env.MISTRAL_API_KEY = "sk-m";
    mockKeysList.mockReturnValue({
      data: [
        { provider: "anthropic", secret_id: "a" },
        { provider: "openai", secret_id: "o" },
      ],
      error: null,
    });
    mockRpc.mockImplementation(async (_fn: string, args: { p_secret_id: string }) =>
      args.p_secret_id === "o"
        ? { data: null, error: { message: "vault down" } }
        : { data: "sk", error: null },
    );
    const sources = await resolveKeySources("org", ["anthropic", "openai", "google", "mistral"]);
    expect(sources.get("anthropic")).toBe(KEY_SOURCE.vault);
    expect(sources.get("openai")).toBe(KEY_SOURCE.none);
    expect(sources.get("google")).toBe(KEY_SOURCE.none);
    expect(sources.get("mistral")).toBe(KEY_SOURCE.env);
  });

  it("throws on a provider_keys read error rather than waving providers in", async () => {
    mockKeysList.mockReturnValue({ data: null, error: new Error("db down") });
    await expect(resolveKeySources("org", ["anthropic"])).rejects.toThrow("db down");
  });
});

describe("hasRuntimeProviderKey / evalRunBlockedForMissingKey (#184)", () => {
  it("blocks a Workspace with no usable key anywhere", async () => {
    expect(await hasRuntimeProviderKey("org")).toBe(false);
    expect(await evalRunBlockedForMissingKey("org")).toBe(true);
  });

  it("admits a Workspace whose only key is a non-Anthropic env var (the judge is provider-aware)", async () => {
    process.env.GOOGLE_API_KEY = "sk-g";
    expect(await evalRunBlockedForMissingKey("org")).toBe(false);
    expect(await countUsableProviders("org")).toBe(1);
  });

  it("admits a Workspace with a usable Vault key", async () => {
    mockKeysList.mockReturnValue({ data: [{ provider: "openai", secret_id: "o" }], error: null });
    expect(await evalRunBlockedForMissingKey("org")).toBe(false);
  });
});

describe("missingKeyError", () => {
  it("names the provider's env var when the provider is known", () => {
    expect(missingKeyError("openai")).toContain("OPENAI_API_KEY");
    expect(missingKeyError()).toContain("Settings");
  });
});
