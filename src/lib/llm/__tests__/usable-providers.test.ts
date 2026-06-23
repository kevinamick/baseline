import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveKeyMode } = vi.hoisted(() => ({ mockResolveKeyMode: vi.fn() }));

// Mock the key-mode resolver (its own DB/billing path is tested in key-gate.test.ts); here we only
// assert how usableProvidersForOrg turns per-provider modes into the wizard's offerings (#204).
// Provide KEY_MODE locally so the real key-gate module (and its supabaseAdmin import) never loads.
vi.mock("@/lib/llm/key-gate", () => ({
  KEY_MODE: { byo: "byo", managed: "managed", blocked: "blocked" },
  resolveKeyModeForEstimate: mockResolveKeyMode,
}));

import { usableProvidersForOrg } from "@/lib/llm/usable-providers";

beforeEach(() => vi.clearAllMocks());

// Resolve each provider to a fixed mode by name.
function modesByProvider(map: Record<string, "byo" | "managed" | "blocked">) {
  mockResolveKeyMode.mockImplementation((_org: string, provider: string) =>
    Promise.resolve(map[provider] ?? "blocked"),
  );
}

describe("usableProvidersForOrg (#204)", () => {
  it("includes a provider with a BYO key as keySource 'byo'", async () => {
    modesByProvider({ anthropic: "byo", openai: "blocked", google: "blocked" });
    const usable = await usableProvidersForOrg("org");
    expect(usable).toEqual([{ provider: "anthropic", keySource: "byo" }]);
  });

  it("includes a managed-eligible priced provider as keySource 'managed'", async () => {
    modesByProvider({ anthropic: "managed", openai: "managed", google: "managed" });
    const usable = await usableProvidersForOrg("org");
    expect(usable).toEqual([
      { provider: "anthropic", keySource: "managed" },
      { provider: "openai", keySource: "managed" },
      { provider: "google", keySource: "managed" },
    ]);
  });

  it("omits a Free Team's blocked providers entirely", async () => {
    modesByProvider({ anthropic: "blocked", openai: "byo", google: "blocked" });
    const usable = await usableProvidersForOrg("org");
    expect(usable).toEqual([{ provider: "openai", keySource: "byo" }]);
  });

  it("returns nothing when no provider is usable", async () => {
    modesByProvider({ anthropic: "blocked", openai: "blocked", google: "blocked" });
    expect(await usableProvidersForOrg("org")).toEqual([]);
  });
});
