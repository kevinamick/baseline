import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: these are referenced by the (hoisted) vi.mock factories, which run
// before plain const initializers when the subject is statically imported.
const { mockResolvePeriod, mockMaybeSingle } = vi.hoisted(() => ({
  mockResolvePeriod: vi.fn(),
  mockMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/billing/ledger", () => ({ resolvePointPeriod: mockResolvePeriod }));

// supabaseAdmin chain for the provider_keys lookup in hasRuntimeProviderKey.
vi.mock("@/lib/supabase/admin", () => {
  const builder: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "limit"]) builder[k] = () => builder;
  builder.maybeSingle = mockMaybeSingle;
  return { supabaseAdmin: { from: () => builder } };
});

import { evalRunBlockedForMissingKey } from "@/lib/llm/key-gate";

const PERIOD_START = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("evalRunBlockedForMissingKey (#184)", () => {
  it("never blocks a paid Team — it falls back to the managed key", async () => {
    mockResolvePeriod.mockResolvedValue({ plan: "builder", start: PERIOD_START });
    const result = await evalRunBlockedForMissingKey("org_paid");
    expect(result).toEqual({ blocked: false });
    // The key table is never even consulted for a paid Team.
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("does not block a Free Team that has a runtime-provider key", async () => {
    mockResolvePeriod.mockResolvedValue({ plan: "free", start: PERIOD_START });
    mockMaybeSingle.mockResolvedValue({ data: { provider: "anthropic" }, error: null });
    const result = await evalRunBlockedForMissingKey("org_free_keyed");
    expect(result).toEqual({ blocked: false });
  });

  it("blocks a Free Team with no key, returning the period start for throttling", async () => {
    mockResolvePeriod.mockResolvedValue({ plan: "free", start: PERIOD_START });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await evalRunBlockedForMissingKey("org_free_keyless");
    expect(result).toEqual({ blocked: true, periodStart: PERIOD_START.toISOString() });
  });

  it("fails closed: an unreadable key table leaves a Free Team blocked", async () => {
    mockResolvePeriod.mockResolvedValue({ plan: "free", start: PERIOD_START });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const result = await evalRunBlockedForMissingKey("org_free_dberr");
    expect(result).toEqual({ blocked: true, periodStart: PERIOD_START.toISOString() });
  });
});
