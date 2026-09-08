import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveKeySources } = vi.hoisted(() => ({ mockResolveKeySources: vi.fn() }));

// Mock the batched key resolver (its own Vault/env path is tested in key-gate.test.ts); here we
// only assert how usableProvidersForOrg turns per-provider sources into the wizard's offerings.
vi.mock("@/lib/llm/key-gate", () => ({
  KEY_SOURCE: { vault: "vault", env: "env", none: "none" },
  resolveKeySources: mockResolveKeySources,
}));

import { usableProvidersForOrg } from "@/lib/llm/usable-providers";

beforeEach(() => vi.clearAllMocks());

function sourcesByProvider(map: Record<string, "vault" | "env" | "none">) {
  mockResolveKeySources.mockImplementation((_org: string, providers: string[]) =>
    Promise.resolve(new Map(providers.map((p) => [p, map[p] ?? "none"]))),
  );
}

describe("usableProvidersForOrg (ADR-0020)", () => {
  it("includes a provider with a Vault key as keySource 'vault'", async () => {
    sourcesByProvider({ anthropic: "vault" });
    expect(await usableProvidersForOrg("org")).toEqual([{ provider: "anthropic", keySource: "vault" }]);
  });

  it("includes a provider with only an env key as keySource 'env', in registry order", async () => {
    sourcesByProvider({ anthropic: "env", openai: "vault", google: "env", mistral: "env" });
    expect(await usableProvidersForOrg("org")).toEqual([
      { provider: "anthropic", keySource: "env" },
      { provider: "openai", keySource: "vault" },
      { provider: "google", keySource: "env" },
      { provider: "mistral", keySource: "env" },
    ]);
  });

  it("omits providers with no key entirely", async () => {
    sourcesByProvider({ openai: "vault" });
    expect(await usableProvidersForOrg("org")).toEqual([{ provider: "openai", keySource: "vault" }]);
  });

  it("returns nothing when no provider is usable", async () => {
    sourcesByProvider({});
    expect(await usableProvidersForOrg("org")).toEqual([]);
  });
});
