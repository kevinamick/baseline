import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced by the (hoisted) vi.mock factories, which run before
// plain const initializers when the subject is statically imported.
const { mockGetBillingState, mockMaybeSingle, mockKeysList } = vi.hoisted(() => ({
  mockGetBillingState: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockKeysList: vi.fn(),
}));

vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

// supabaseAdmin chain. hasRuntimeProviderKey/resolveKeyModeForEstimate terminate on
// .maybeSingle(); the batched resolveKeyModesForEstimate awaits the builder itself
// after .in() (no terminal call), so the builder is also a thenable backed by mockKeysList.
vi.mock("@/lib/supabase/admin", () => {
  const builder: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "limit"]) builder[k] = () => builder;
  builder.maybeSingle = mockMaybeSingle;
  builder.then = (resolve: (v: unknown) => unknown) => resolve(mockKeysList());
  return { supabaseAdmin: { from: () => builder } };
});

import {
  evalRunBlockedForMissingKey,
  resolveKeyModeForEstimate,
  resolveKeyModesForEstimate,
} from "@/lib/llm/key-gate";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("evalRunBlockedForMissingKey (#184)", () => {
  it("never blocks a paid Team — it falls back to the managed key", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    expect(await evalRunBlockedForMissingKey("org_paid")).toBe(false);
    // The key table is never even consulted for a paid Team.
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("does not block a Free Team that has a runtime-provider key", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockMaybeSingle.mockResolvedValue({ data: { provider: "anthropic" }, error: null });
    expect(await evalRunBlockedForMissingKey("org_free_keyed")).toBe(false);
  });

  it("blocks a Free Team with no key", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await evalRunBlockedForMissingKey("org_free_keyless")).toBe(true);
  });

  it("fails closed: an unreadable key table leaves a Free Team blocked", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await evalRunBlockedForMissingKey("org_free_dberr")).toBe(true);
  });
});

// The key-mode matrix (#185 AC: "BYO present → byo; paid w/o key → managed; Free
// w/o key → blocked, never managed"). Mirrors the worker's run-time precedence.
describe("resolveKeyModeForEstimate (#185)", () => {
  it("returns 'byo' whenever a key exists for the provider — on any plan", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { provider: "anthropic" }, error: null });
    // Free + key, paid + key both resolve to byo (billing state never consulted).
    expect(await resolveKeyModeForEstimate("org", "anthropic")).toBe("byo");
    expect(mockGetBillingState).not.toHaveBeenCalled();
  });

  it("returns 'managed' for a paid Team with no BYO key", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    expect(await resolveKeyModeForEstimate("org", "anthropic")).toBe("managed");
  });

  it("returns 'blocked' for a Free Team with no BYO key — never managed", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    expect(await resolveKeyModeForEstimate("org", "anthropic")).toBe("blocked");
  });
});

// The batched form (#204): one provider_keys read + one getBillingState resolve the
// whole set, applying the same precedence per provider as the single-provider form.
describe("resolveKeyModesForEstimate (#204)", () => {
  it("resolves the set in a single billing read, byo per stored provider", async () => {
    // anthropic has a BYO key; the paid plan makes the rest 'managed'.
    mockKeysList.mockReturnValue({ data: [{ provider: "anthropic" }], error: null });
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    const modes = await resolveKeyModesForEstimate("org", ["anthropic", "openai", "google"]);
    expect(modes.get("anthropic")).toBe("byo");
    expect(modes.get("openai")).toBe("managed");
    expect(modes.get("google")).toBe("managed");
    // Billing state consulted once for the whole set, not once per provider.
    expect(mockGetBillingState).toHaveBeenCalledTimes(1);
  });

  it("a Free Team's keyless providers are 'blocked', never 'managed'", async () => {
    mockKeysList.mockReturnValue({ data: [{ provider: "openai" }], error: null });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    const modes = await resolveKeyModesForEstimate("org", ["anthropic", "openai"]);
    expect(modes.get("anthropic")).toBe("blocked");
    expect(modes.get("openai")).toBe("byo");
  });

  it("fails closed: an unreadable key table throws rather than waving providers in", async () => {
    mockKeysList.mockReturnValue({ data: null, error: { message: "boom" } });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    await expect(resolveKeyModesForEstimate("org", ["anthropic"])).rejects.toBeTruthy();
  });
});
