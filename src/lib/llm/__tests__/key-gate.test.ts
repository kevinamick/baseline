import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced by the (hoisted) vi.mock factories, which run before
// plain const initializers when the subject is statically imported.
const { mockGetBillingState, mockMaybeSingle } = vi.hoisted(() => ({
  mockGetBillingState: vi.fn(),
  mockMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

// supabaseAdmin chain for the provider_keys lookup in hasRuntimeProviderKey.
vi.mock("@/lib/supabase/admin", () => {
  const builder: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "limit"]) builder[k] = () => builder;
  builder.maybeSingle = mockMaybeSingle;
  return { supabaseAdmin: { from: () => builder } };
});

import { evalRunBlockedForMissingKey } from "@/lib/llm/key-gate";

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
