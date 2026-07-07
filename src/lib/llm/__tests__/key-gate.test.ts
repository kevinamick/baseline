import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced by the (hoisted) vi.mock factories, which run before
// plain const initializers when the subject is statically imported.
const { mockGetBillingState, mockMaybeSingle, mockKeysList, mockRpc } = vi.hoisted(
  () => ({
    mockGetBillingState: vi.fn(),
    mockMaybeSingle: vi.fn(),
    mockKeysList: vi.fn(),
    mockRpc: vi.fn(),
  }),
);

vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

// supabaseAdmin chain. resolveKeyModeForEstimate terminates on .maybeSingle();
// hasRuntimeProviderKey and the batched resolveKeyModesForEstimate await the builder
// itself after .in() (no terminal call), so the builder is also a thenable backed by
// mockKeysList. Every path now reads `secret_id` (never bare row existence) and
// verifies usability via the get_provider_secret RPC (mockRpc) — the app's
// isSecretUsable mirrors the worker's readUsableByoKey (#371).
vi.mock("@/lib/supabase/admin", () => {
  const builder: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "limit"]) builder[k] = () => builder;
  builder.maybeSingle = mockMaybeSingle;
  builder.then = (resolve: (v: unknown) => unknown) => resolve(mockKeysList());
  return { supabaseAdmin: { from: () => builder, rpc: mockRpc } };
});

import {
  evalRunBlockedForMissingKey,
  resolveKeyModeForEstimate,
  resolveKeyModesForEstimate,
  resolveJudgeKeyModeForEstimate,
  managedRunBlockedForPayment,
} from "@/lib/llm/key-gate";

vi.mock("@/lib/billing/managed-spend", () => ({
  isManagedPaymentBlocked: vi.fn().mockResolvedValue(false),
}));

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

  it("does not block a Free Team that has a usable runtime-provider key", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({ data: [{ secret_id: "sec_1" }], error: null });
    mockRpc.mockResolvedValue({ data: "sk-real-key", error: null });
    expect(await evalRunBlockedForMissingKey("org_free_keyed")).toBe(false);
  });

  it("blocks a Free Team whose only key row has an empty/whitespace secret", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({ data: [{ secret_id: "sec_blank" }], error: null });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    expect(await evalRunBlockedForMissingKey("org_free_blank")).toBe(true);
  });

  it("blocks a Free Team with no key", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({ data: [], error: null });
    expect(await evalRunBlockedForMissingKey("org_free_keyless")).toBe(true);
  });

  it("fails closed: an unreadable key table leaves a Free Team blocked", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({ data: null, error: { message: "boom" } });
    expect(await evalRunBlockedForMissingKey("org_free_dberr")).toBe(true);
  });

  it("fails closed: a secret-read error does not count the key as usable", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({ data: [{ secret_id: "sec_1" }], error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: "vault down" } });
    expect(await evalRunBlockedForMissingKey("org_free_secret_err")).toBe(true);
  });

  it("falls through an empty-secret row to a later usable row (#371)", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({
      data: [{ secret_id: "sec_blank" }, { secret_id: "sec_usable" }],
      error: null,
    });
    mockRpc.mockImplementation((_fn: string, { p_secret_id }: { p_secret_id: string }) =>
      Promise.resolve({
        data: p_secret_id === "sec_usable" ? "sk-real-key" : "   ",
        error: null,
      }),
    );
    expect(await evalRunBlockedForMissingKey("org_free_fallthrough")).toBe(false);
  });
});

// The key-mode matrix (#185 AC: "BYO present → byo; paid w/o key → managed; Free
// w/o key → blocked, never managed"). Mirrors the worker's run-time precedence,
// including secret usability (#371): a row with an empty/whitespace secret is
// never "byo".
describe("resolveKeyModeForEstimate (#185, #371)", () => {
  it("returns 'byo' when a usable key exists for the provider — on any plan", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec_1" }, error: null });
    mockRpc.mockResolvedValue({ data: "sk-real-key", error: null });
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

  it("a whitespace-only secret does not count as BYO — falls through to managed for a paid Team", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec_blank" }, error: null });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    expect(await resolveKeyModeForEstimate("org", "anthropic")).toBe("managed");
  });

  it("a whitespace-only secret does not count as BYO — falls through to blocked for a Free Team", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec_blank" }, error: null });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    expect(await resolveKeyModeForEstimate("org", "anthropic")).toBe("blocked");
  });

  it("fails closed: a secret-read RPC error does not count the key as usable", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec_1" }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: "vault down" } });
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    expect(await resolveKeyModeForEstimate("org", "anthropic")).toBe("managed");
  });

  it("throws when the provider_keys row read fails", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(resolveKeyModeForEstimate("org", "anthropic")).rejects.toBeTruthy();
  });
});

// The batched form (#204): one provider_keys read + one getBillingState resolve the
// whole set, applying the same usability-aware precedence per provider as the
// single-provider form (#371).
describe("resolveKeyModesForEstimate (#204, #371)", () => {
  it("resolves the set in a single billing read, byo per usable stored provider", async () => {
    // anthropic has a usable BYO key; the paid plan makes the rest 'managed'.
    mockKeysList.mockReturnValue({
      data: [{ provider: "anthropic", secret_id: "sec_anthropic" }],
      error: null,
    });
    mockRpc.mockResolvedValue({ data: "sk-real-key", error: null });
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    const modes = await resolveKeyModesForEstimate("org", ["anthropic", "openai", "google"]);
    expect(modes.get("anthropic")).toBe("byo");
    expect(modes.get("openai")).toBe("managed");
    expect(modes.get("google")).toBe("managed");
    // Billing state consulted once for the whole set, not once per provider.
    expect(mockGetBillingState).toHaveBeenCalledTimes(1);
  });

  it("a Free Team's keyless providers are 'blocked', never 'managed'", async () => {
    mockKeysList.mockReturnValue({
      data: [{ provider: "openai", secret_id: "sec_openai" }],
      error: null,
    });
    mockRpc.mockResolvedValue({ data: "sk-real-key", error: null });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    const modes = await resolveKeyModesForEstimate("org", ["anthropic", "openai"]);
    expect(modes.get("anthropic")).toBe("blocked");
    expect(modes.get("openai")).toBe("byo");
  });

  it("a stored row with an empty/whitespace secret is never 'byo' (#371)", async () => {
    mockKeysList.mockReturnValue({
      data: [{ provider: "anthropic", secret_id: "sec_blank" }],
      error: null,
    });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    const modes = await resolveKeyModesForEstimate("org", ["anthropic"]);
    expect(modes.get("anthropic")).toBe("managed");
  });

  it("fails closed: an unreadable key table throws rather than waving providers in", async () => {
    mockKeysList.mockReturnValue({ data: null, error: { message: "boom" } });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    await expect(resolveKeyModesForEstimate("org", ["anthropic"])).rejects.toBeTruthy();
  });
});

// #371 acceptance scenario: a paid Team with an empty/whitespace-secret Anthropic
// row PLUS a usable OpenAI row must resolve BYO — the judge path scans every
// runtime-ready provider rather than stopping at the first row it finds, so the
// blank Anthropic row never masks the usable OpenAI one.
describe("resolveJudgeKeyModeForEstimate (#371)", () => {
  it("resolves byo when the ONLY row's secret is usable", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockKeysList.mockReturnValue({ data: [{ secret_id: "sec_openai" }], error: null });
    mockRpc.mockResolvedValue({ data: "sk-openai-byo", error: null });
    expect(await resolveJudgeKeyModeForEstimate("org")).toBe("byo");
  });

  it("resolves byo via a later usable row when an earlier row's secret is blank", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockKeysList.mockReturnValue({
      data: [{ secret_id: "sec_anthropic_blank" }, { secret_id: "sec_openai_usable" }],
      error: null,
    });
    mockRpc.mockImplementation((_fn: string, { p_secret_id }: { p_secret_id: string }) =>
      Promise.resolve({
        data: p_secret_id === "sec_openai_usable" ? "sk-openai-byo" : "   ",
        error: null,
      }),
    );
    expect(await resolveJudgeKeyModeForEstimate("org")).toBe("byo");
  });

  it("falls back to managed for a paid Team when every row is unusable", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockKeysList.mockReturnValue({ data: [{ secret_id: "sec_blank" }], error: null });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    expect(await resolveJudgeKeyModeForEstimate("org")).toBe("managed");
  });

  it("blocks a Free Team when every row is unusable — never managed", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockKeysList.mockReturnValue({ data: [{ secret_id: "sec_blank" }], error: null });
    mockRpc.mockResolvedValue({ data: "   ", error: null });
    expect(await resolveJudgeKeyModeForEstimate("org")).toBe("blocked");
  });
});

describe("managedRunBlockedForPayment (#186)", () => {
  it("is never blocked when the provider resolves to byo, even with an unreadable payment flag", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { secret_id: "sec_1" }, error: null });
    mockRpc.mockResolvedValue({ data: "sk-real-key", error: null });
    expect(await managedRunBlockedForPayment("org", "anthropic")).toBe(false);
  });
});
