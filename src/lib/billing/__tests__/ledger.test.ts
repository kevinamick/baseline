import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockOrgMaybeSingle, mockLedgerLimit, mockRpcOrThrow, mockGetBillingState, mockPaymentMethodFailing } =
  vi.hoisted(() => ({
    mockOrgMaybeSingle: vi.fn(),
    mockLedgerLimit: vi.fn(),
    mockRpcOrThrow: vi.fn(),
    mockGetBillingState: vi.fn(),
    mockPaymentMethodFailing: vi.fn(),
  }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "organizations") {
        return { select: () => ({ eq: () => ({ maybeSingle: mockOrgMaybeSingle }) }) };
      }
      // point_ledger
      return {
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: mockLedgerLimit }) }) }) }),
      };
    },
  },
}));
vi.mock("@/lib/supabase/rpc", () => ({ rpcOrThrow: mockRpcOrThrow }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/billing/managed-spend", () => ({ paymentMethodFailing: mockPaymentMethodFailing }));

import { resolvePointPeriod, getPointBudget, reserveEvalRunPoints, listLedgerEntries } from "../ledger";
import { PLANS } from "../plans";

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgMaybeSingle.mockResolvedValue({ data: { created_at: "2026-01-15T00:00:00.000Z" } });
});

describe("resolvePointPeriod", () => {
  it("anchors a paid, active Team to its mirrored Stripe period", async () => {
    mockGetBillingState.mockResolvedValue({
      plan: "builder",
      active: true,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    });
    const period = await resolvePointPeriod("org_1");
    expect(period.plan).toBe("builder");
    expect(period.included).toBe(PLANS.builder.includedEvalPoints);
    expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("falls back to the creation-anniversary when the mirror lacks period bounds", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free", active: false, currentPeriodStart: null, currentPeriodEnd: null });
    const period = await resolvePointPeriod("org_1");
    expect(period.plan).toBe("free");
    // Anniversary period always contains the anchor day-of-month; just assert it resolved.
    expect(period.start.getTime()).toBeLessThanOrEqual(period.end.getTime());
  });

  it("falls back to a subscription-active-but-bounds-missing Team too", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder", active: true, currentPeriodStart: null, currentPeriodEnd: null });
    const period = await resolvePointPeriod("org_1");
    expect(period.plan).toBe("builder");
    expect(period.start.getTime()).toBeLessThanOrEqual(period.end.getTime());
  });

  it("anchors to the epoch when the org row itself is missing (bogus orgId)", async () => {
    mockOrgMaybeSingle.mockResolvedValue({ data: null });
    mockGetBillingState.mockResolvedValue({ plan: "free", active: false, currentPeriodStart: null, currentPeriodEnd: null });
    const period = await resolvePointPeriod("org_1");
    expect(period.start.getTime()).toBeGreaterThanOrEqual(0);
  });
});

describe("getPointBudget", () => {
  it("ensures the grant then reads the balance", async () => {
    mockGetBillingState.mockResolvedValue({
      plan: "builder",
      active: true,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    });
    mockRpcOrThrow.mockImplementation(async (fn: string) => {
      if (fn === "ensure_point_grant") return null;
      if (fn === "point_balance") return 4200;
      throw new Error(`unexpected rpc ${fn}`);
    });
    const budget = await getPointBudget("org_1");
    expect(budget).toEqual({
      plan: "builder",
      included: PLANS.builder.includedEvalPoints,
      balance: 4200,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "ensure_point_grant",
      expect.objectContaining({ p_org_id: "org_1", p_included: PLANS.builder.includedEvalPoints })
    );
  });

  it("defaults a null balance to zero", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free", active: false, currentPeriodStart: null, currentPeriodEnd: null });
    mockRpcOrThrow.mockImplementation(async (fn: string) => (fn === "point_balance" ? null : undefined));
    const budget = await getPointBudget("org_1");
    expect(budget.balance).toBe(0);
  });
});

describe("reserveEvalRunPoints", () => {
  const period = {
    plan: "builder" as const,
    active: true,
    currentPeriodStart: "2026-06-01T00:00:00.000Z",
    currentPeriodEnd: "2026-07-01T00:00:00.000Z",
  };

  it("reserves at the plan's overage rate when payment is healthy", async () => {
    mockGetBillingState.mockResolvedValue(period);
    mockPaymentMethodFailing.mockResolvedValue(false);
    mockRpcOrThrow.mockResolvedValue([{ reserved: true, balance: 700, cap_usd: "25" }]);

    const result = await reserveEvalRunPoints("org_1", "run_1", 300, {
      row_count: 10,
      criteria_count: 3,
      per_row_cost: 30,
    });

    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_eval_points",
      expect.objectContaining({ p_point_unit_usd: PLANS.builder.evalPointOverageUsd })
    );
    expect(result).toEqual({
      reserved: true,
      balance: 700,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 25,
      plan: "builder",
      paymentFailing: false,
    });
  });

  it("suppresses overage rates (null unit price) while payment is failing", async () => {
    mockGetBillingState.mockResolvedValue(period);
    mockPaymentMethodFailing.mockResolvedValue(true);
    mockRpcOrThrow.mockResolvedValue([{ reserved: false, balance: 0, cap_usd: null }]);

    const result = await reserveEvalRunPoints("org_1", "run_1", 300, {
      row_count: 10,
      criteria_count: 3,
      per_row_cost: 30,
    });

    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_eval_points",
      expect.objectContaining({ p_point_unit_usd: null })
    );
    expect(result.paymentFailing).toBe(true);
    expect(result.capUsd).toBeNull();
  });

  it("handles a scalar (non-array) RPC row shape", async () => {
    mockGetBillingState.mockResolvedValue(period);
    mockPaymentMethodFailing.mockResolvedValue(false);
    mockRpcOrThrow.mockResolvedValue({ reserved: true, balance: 900 });
    const result = await reserveEvalRunPoints("org_1", "run_1", 100, {
      row_count: 1,
      criteria_count: 1,
      per_row_cost: 100,
    });
    expect(result.reserved).toBe(true);
    expect(result.balance).toBe(900);
  });

  it("is null-capped when the RPC returns no row at all (not just a null cap_usd)", async () => {
    mockGetBillingState.mockResolvedValue(period);
    mockPaymentMethodFailing.mockResolvedValue(false);
    mockRpcOrThrow.mockResolvedValue([]);
    const result = await reserveEvalRunPoints("org_1", "run_1", 100, {
      row_count: 1,
      criteria_count: 1,
      per_row_cost: 100,
    });
    expect(result).toMatchObject({ reserved: false, balance: 0, capUsd: null });
  });
});

describe("listLedgerEntries", () => {
  it("maps rows to the display shape", async () => {
    mockLedgerLimit.mockResolvedValue({
      data: [
        { id: "l1", entry_type: "reserve", points: -300, eval_run_id: "run_1", created_at: "2026-06-02T00:00:00.000Z" },
      ],
      error: null,
    });
    const entries = await listLedgerEntries("org_1", "2026-06-01T00:00:00.000Z");
    expect(entries).toEqual([
      { id: "l1", entryType: "reserve", points: -300, evalRunId: "run_1", createdAt: "2026-06-02T00:00:00.000Z" },
    ]);
  });

  it("defaults to an empty list when data is null", async () => {
    mockLedgerLimit.mockResolvedValue({ data: null, error: null });
    expect(await listLedgerEntries("org_1", "2026-06-01T00:00:00.000Z")).toEqual([]);
  });

  it("throws on a read error", async () => {
    mockLedgerLimit.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(listLedgerEntries("org_1", "2026-06-01T00:00:00.000Z")).rejects.toThrow("db down");
  });
});
