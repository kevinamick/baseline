import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockMaybeSingle, mockRpc, mockNotify } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
    }),
    rpc: mockRpc,
  },
}));
vi.mock("@/lib/billing/limit-notifications", () => ({ notifyLimitOnce: mockNotify }));
vi.mock("@/lib/logging/server", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  overageRatesForPlan,
  projectedOverageUsd,
  getOverageCap,
  maybeWarnNearCap,
  OVERAGE_WARNING_RATIO,
} from "../overage";
import { PLANS } from "../plans";

beforeEach(() => {
  vi.clearAllMocks();
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("overageRatesForPlan", () => {
  it("returns the paid plans' point rate and null for Free (no overage option)", () => {
    expect(overageRatesForPlan("builder")).toEqual({
      pointUnitUsd: PLANS.builder.evalPointOverageUsd,
    });
    expect(overageRatesForPlan("scale")).not.toBeNull();
    expect(overageRatesForPlan("free")).toBeNull();
  });
});

describe("projectedOverageUsd", () => {
  // Single points meter now (ADR-0016): Optimization Run overage is points too.
  const rates = { pointUnitUsd: 0.001 };

  it("is zero while the point balance is non-negative", () => {
    expect(projectedOverageUsd(0, rates)).toBe(0);
    expect(projectedOverageUsd(500, rates)).toBe(0);
  });

  it("prices the point balance's negative magnitude", () => {
    expect(projectedOverageUsd(-2_000, rates)).toBe(2);
    expect(projectedOverageUsd(-1_000, rates)).toBe(1);
  });
});

describe("getOverageCap", () => {
  it("returns the numeric cap, and null when the row or cap is absent", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { overage_cap_usd: "25" }, error: null });
    expect(await getOverageCap("org_1")).toBe(25);
    mockMaybeSingle.mockResolvedValue({ data: { overage_cap_usd: null }, error: null });
    expect(await getOverageCap("org_1")).toBeNull();
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getOverageCap("org_1")).toBeNull();
  });
});

describe("maybeWarnNearCap", () => {
  const period = "2026-06-01T00:00:00.000Z";

  function balances(points: number, runs: number) {
    mockRpc.mockImplementation(async (fn: string) => ({
      data: fn === "point_balance" ? points : runs,
      error: null,
    }));
  }

  it("stays silent below the warning threshold", async () => {
    // $10 cap; committed $4 (8000 points over at builder's $0.0005).
    balances(-8_000, 0);
    await maybeWarnNearCap("org_1", { capUsd: 10, plan: "builder", periodStart: period });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it(`emails once committed overage crosses ${OVERAGE_WARNING_RATIO * 100}% of the cap`, async () => {
    // $10 cap; committed $8.50 (17000 points over at $0.0005).
    balances(-17_000, 0);
    await maybeWarnNearCap("org_1", { capUsd: 10, plan: "builder", periodStart: period });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "overage_warning", periodStart: period })
    );
  });

  it("never throws — a failed check must not fail the run", async () => {
    mockRpc.mockRejectedValue(new Error("db down"));
    await expect(
      maybeWarnNearCap("org_1", { capUsd: 10, plan: "builder", periodStart: period })
    ).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});