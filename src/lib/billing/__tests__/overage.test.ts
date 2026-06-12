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
  getOverageState,
  maybeWarnNearCap,
  OVERAGE_WARNING_RATIO,
} from "../overage";
import { PLANS } from "../plans";

beforeEach(() => {
  vi.clearAllMocks();
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("overageRatesForPlan", () => {
  it("returns the paid plans' rates and null for Free (no overage option)", () => {
    expect(overageRatesForPlan("builder")).toEqual({
      pointUnitUsd: PLANS.builder.evalPointOverageUsd,
      runUnitUsd: PLANS.builder.optimizationRunOverageUsd,
    });
    expect(overageRatesForPlan("scale")).not.toBeNull();
    expect(overageRatesForPlan("free")).toBeNull();
  });
});

describe("projectedOverageUsd", () => {
  const rates = { pointUnitUsd: 0.001, runUnitUsd: 1.5 };

  it("is zero while both balances are non-negative", () => {
    expect(projectedOverageUsd(0, 0, rates)).toBe(0);
    expect(projectedOverageUsd(500, 3, rates)).toBe(0);
  });

  it("prices each meter's negative balance and sums them", () => {
    expect(projectedOverageUsd(-2_000, 0, rates)).toBe(2);
    expect(projectedOverageUsd(0, -2, rates)).toBe(3);
    expect(projectedOverageUsd(-1_000, -1, rates)).toBe(2.5);
  });

  it("never lets surplus on one meter offset overage on the other", () => {
    expect(projectedOverageUsd(50_000, -2, rates)).toBe(3);
  });
});

describe("getOverageState", () => {
  it("reads the cap only for plans with rates and splits the overage", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { overage_cap_usd: "25" }, error: null });
    const state = await getOverageState("org_1", {
      pointBalance: -4_000,
      runBalance: -1,
      plan: "builder",
    });
    expect(state.capUsd).toBe(25);
    expect(state.pointsOver).toBe(4_000);
    expect(state.runsOver).toBe(1);
    // 4000 × $0.0005 + 1 × $1.50
    expect(state.committedUsd).toBeCloseTo(3.5);
  });

  it("Free has no overage option: rates null, cap never read", async () => {
    const state = await getOverageState("org_1", {
      pointBalance: -10,
      runBalance: 0,
      plan: "free",
    });
    expect(state.rates).toBeNull();
    expect(state.capUsd).toBeNull();
    expect(state.committedUsd).toBe(0);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
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