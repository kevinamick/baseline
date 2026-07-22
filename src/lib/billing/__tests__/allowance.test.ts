import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockRpcOrThrow, mockSettleRpc, mockResolvePointPeriod, mockPaymentMethodFailing } = vi.hoisted(() => ({
  mockRpcOrThrow: vi.fn(),
  mockSettleRpc: vi.fn(),
  mockResolvePointPeriod: vi.fn(),
  mockPaymentMethodFailing: vi.fn(),
}));

vi.mock("@/lib/supabase/rpc", () => ({ rpcOrThrow: mockRpcOrThrow }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mockSettleRpc },
}));
vi.mock("@/lib/billing/ledger", () => ({ resolvePointPeriod: mockResolvePointPeriod }));
vi.mock("@/lib/billing/managed-spend", () => ({ paymentMethodFailing: mockPaymentMethodFailing }));

import {
  getOptimizationAllowance,
  reserveOptimizationRun,
  settleOptimizationRunUnit,
  reserveOptimizationPoints,
  settleOptimizationRunPoints,
} from "../allowance";
import { PLANS } from "../plans";

const PERIOD = {
  plan: "builder" as const,
  included: PLANS.builder.includedEvalPoints,
  start: new Date("2026-06-01T00:00:00.000Z"),
  end: new Date("2026-07-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePointPeriod.mockResolvedValue(PERIOD);
});

describe("getOptimizationAllowance", () => {
  it("reconciles the grant then reads the balance", async () => {
    mockRpcOrThrow.mockImplementation(async (fn: string) => {
      if (fn === "reconcile_optimization_grant") return null;
      if (fn === "optimization_run_balance") return 12;
      throw new Error(`unexpected rpc ${fn}`);
    });
    const allowance = await getOptimizationAllowance("org_1");
    expect(allowance).toEqual({
      plan: "builder",
      included: PLANS.builder.includedOptimizationRuns,
      lifetime: false,
      maxBudgetRollouts: PLANS.builder.maxBudgetRollouts,
      remaining: 12,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    expect(mockRpcOrThrow).toHaveBeenCalledWith("reconcile_optimization_grant", {
      p_org_id: "org_1",
      p_period_start: "2026-06-01T00:00:00.000Z",
      p_period_end: "2026-07-01T00:00:00.000Z",
      p_included_runs: PLANS.builder.includedOptimizationRuns,
    });
    // Per-period plans never consult the lifetime counter.
    expect(mockRpcOrThrow).not.toHaveBeenCalledWith(
      "optimization_lifetime_used",
      expect.anything()
    );
  });

  it("defaults a null balance to zero", async () => {
    mockRpcOrThrow.mockResolvedValue(null);
    const allowance = await getOptimizationAllowance("org_1");
    expect(allowance.remaining).toBe(0);
  });

  // Free's grant is lifetime-scoped: the effective included count subtracts
  // units net-consumed across ALL periods (optimization_lifetime_used), so the
  // one-time run grants once and never resets.
  describe("lifetime grant (Free)", () => {
    beforeEach(() => {
      mockResolvePointPeriod.mockResolvedValue({ ...PERIOD, plan: "free" });
    });

    function rpcWith(lifetimeUsed: number, balance: number) {
      mockRpcOrThrow.mockImplementation(async (fn: string) => {
        if (fn === "optimization_lifetime_used") return lifetimeUsed;
        if (fn === "reconcile_optimization_grant") return null;
        if (fn === "optimization_run_balance") return balance;
        throw new Error(`unexpected rpc ${fn}`);
      });
    }

    it("grants the plan's count while nothing was ever consumed", async () => {
      rpcWith(0, 1);
      const allowance = await getOptimizationAllowance("org_free");
      expect(allowance.included).toBe(PLANS.free.includedOptimizationRuns);
      expect(allowance.lifetime).toBe(true);
      expect(mockRpcOrThrow).toHaveBeenCalledWith("reconcile_optimization_grant", {
        p_org_id: "org_free",
        p_period_start: "2026-06-01T00:00:00.000Z",
        p_period_end: "2026-07-01T00:00:00.000Z",
        p_included_runs: PLANS.free.includedOptimizationRuns,
      });
    });

    it("drops the grant to zero once the lifetime unit is consumed", async () => {
      rpcWith(1, 0);
      const allowance = await getOptimizationAllowance("org_free");
      expect(allowance.included).toBe(0);
      expect(mockRpcOrThrow).toHaveBeenCalledWith(
        "reconcile_optimization_grant",
        expect.objectContaining({ p_included_runs: 0 })
      );
    });

    it("never computes a negative included count", async () => {
      rpcWith(3, 0);
      const allowance = await getOptimizationAllowance("org_free");
      expect(allowance.included).toBe(0);
    });

    // CR-1 (#501) regression: the allowance read must ALWAYS call
    // reconcile_optimization_grant (which tops a stale-low frozen grant up
    // via an 'upgrade' delta), never the plain insert-once
    // ensure_optimization_grant — otherwise a period whose grant row was
    // written low before a released unit raised `included` back up stays
    // stranded at a 0 balance forever, even though `included` itself reads
    // correctly. See allowance.integration.test.ts for the SQL-level proof
    // of the actual top-up.
    it("never calls the plain insert-once ensure_optimization_grant directly", async () => {
      rpcWith(0, 1);
      await getOptimizationAllowance("org_free");
      expect(mockRpcOrThrow).not.toHaveBeenCalledWith(
        "ensure_optimization_grant",
        expect.anything()
      );
    });

    it("applies the lifetime subtraction in reserveOptimizationRun's own period resolution", async () => {
      mockRpcOrThrow.mockImplementation(async (fn: string) => {
        if (fn === "optimization_lifetime_used") return 1;
        if (fn === "reserve_optimization_run") return [{ reserved: false, balance: 0 }];
        throw new Error(`unexpected rpc ${fn}`);
      });
      const result = await reserveOptimizationRun("org_free", "run_1");
      expect(mockRpcOrThrow).toHaveBeenCalledWith(
        "reserve_optimization_run",
        expect.objectContaining({ p_included: 0 })
      );
      expect(result.reserved).toBe(false);
    });

    // CR-3: the reserve row carries its own attribution, so nothing downstream
    // has to infer whether a lifetime grant was consumed from mutable state.
    it("stamps a Free reserve as lifetime consumption", async () => {
      mockRpcOrThrow.mockImplementation(async (fn: string) => {
        if (fn === "optimization_lifetime_used") return 0;
        if (fn === "reserve_optimization_run") return [{ reserved: true, balance: 0 }];
        throw new Error(`unexpected rpc ${fn}`);
      });
      await reserveOptimizationRun("org_free", "run_1");
      expect(mockRpcOrThrow).toHaveBeenCalledWith(
        "reserve_optimization_run",
        expect.objectContaining({ p_lifetime: true })
      );
    });

    it("leaves a per-period plan's reserve unflagged", async () => {
      mockRpcOrThrow.mockResolvedValue([{ reserved: true, balance: 5 }]);
      await reserveOptimizationRun("org_1", "run_1", {
        periodStart: "2026-05-01T00:00:00.000Z",
        periodEnd: "2026-06-01T00:00:00.000Z",
        included: 15,
        plan: "builder",
      });
      expect(mockRpcOrThrow).toHaveBeenCalledWith(
        "reserve_optimization_run",
        expect.objectContaining({ p_lifetime: false })
      );
    });
  });
});

describe("reserveOptimizationRun", () => {
  it("resolves the period itself when none is passed", async () => {
    mockRpcOrThrow.mockResolvedValue([{ reserved: true, balance: 5 }]);
    const result = await reserveOptimizationRun("org_1", "run_1");
    expect(mockResolvePointPeriod).toHaveBeenCalledWith("org_1");
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_optimization_run",
      expect.objectContaining({
        p_org_id: "org_1",
        p_run_id: "run_1",
        p_included: PLANS.builder.includedOptimizationRuns,
      })
    );
    expect(result).toEqual({
      reserved: true,
      remaining: 5,
      periodStart: "2026-06-01T00:00:00.000Z",
      plan: "builder",
    });
  });

  it("reuses a caller-supplied period, skipping a second resolution", async () => {
    mockRpcOrThrow.mockResolvedValue([{ reserved: false, balance: 0 }]);
    const result = await reserveOptimizationRun("org_1", "run_1", {
      periodStart: "2026-05-01T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
      included: 15,
      plan: "builder",
    });
    expect(mockResolvePointPeriod).not.toHaveBeenCalled();
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_optimization_run",
      expect.objectContaining({ p_period_start: "2026-05-01T00:00:00.000Z", p_included: 15 })
    );
    expect(result.reserved).toBe(false);
    expect(result.periodStart).toBe("2026-05-01T00:00:00.000Z");
  });

  it("defaults a null balance to zero", async () => {
    mockRpcOrThrow.mockResolvedValue([{ reserved: true }]);
    const result = await reserveOptimizationRun("org_1", "run_1");
    expect(result.remaining).toBe(0);
  });
});

describe("settleOptimizationRunUnit", () => {
  it("returns null error on success", async () => {
    mockSettleRpc.mockResolvedValue({ error: null });
    const result = await settleOptimizationRunUnit("run_1");
    expect(result.error).toBeNull();
    expect(mockSettleRpc).toHaveBeenCalledWith("settle_optimization_run", { p_run_id: "run_1" });
  });

  it("passes through an RPC error rather than throwing", async () => {
    const err = { message: "boom" };
    mockSettleRpc.mockResolvedValue({ error: err });
    const result = await settleOptimizationRunUnit("run_1");
    expect(result.error).toBe(err);
  });
});

describe("reserveOptimizationPoints", () => {
  const meta = { criteria_count: 3, budget_rollouts: 50, per_rollout_cost: 30 };

  it("reserves at the plan's overage rate when payment is healthy", async () => {
    mockPaymentMethodFailing.mockResolvedValue(false);
    mockRpcOrThrow.mockResolvedValue([{ reserved: true, balance: 400, cap_usd: "25" }]);
    const result = await reserveOptimizationPoints("org_1", "run_1", 1500, meta);
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_optimization_points",
      expect.objectContaining({ p_point_unit_usd: PLANS.builder.evalPointOverageUsd, p_cost: 1500 })
    );
    expect(result).toEqual({
      reserved: true,
      balance: 400,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 25,
      plan: "builder",
      paymentFailing: false,
    });
  });

  it("suppresses overage rates while payment is failing", async () => {
    mockPaymentMethodFailing.mockResolvedValue(true);
    mockRpcOrThrow.mockResolvedValue([{ reserved: false, balance: 0, cap_usd: null }]);
    const result = await reserveOptimizationPoints("org_1", "run_1", 1500, meta);
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_optimization_points",
      expect.objectContaining({ p_point_unit_usd: null })
    );
    expect(result.paymentFailing).toBe(true);
    expect(result.capUsd).toBeNull();
  });

  it("is null-capped when the RPC returns no row at all (not just a null cap_usd)", async () => {
    mockPaymentMethodFailing.mockResolvedValue(false);
    mockRpcOrThrow.mockResolvedValue([]);
    const result = await reserveOptimizationPoints("org_1", "run_1", 1500, meta);
    expect(result).toMatchObject({ reserved: false, balance: 0, capUsd: null });
  });
});

describe("settleOptimizationRunPoints", () => {
  it("returns null error on success", async () => {
    mockSettleRpc.mockResolvedValue({ error: null });
    const result = await settleOptimizationRunPoints("run_1", "completed");
    expect(result.error).toBeNull();
    expect(mockSettleRpc).toHaveBeenCalledWith("settle_optimization_run_points", {
      p_run_id: "run_1",
      p_outcome: "completed",
    });
  });

  it("passes through an RPC error rather than throwing", async () => {
    const err = { message: "boom" };
    mockSettleRpc.mockResolvedValue({ error: err });
    const result = await settleOptimizationRunPoints("run_1", "failed");
    expect(result.error).toBe(err);
  });
});
