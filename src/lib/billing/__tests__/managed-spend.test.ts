import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockCapMaybeSingle,
  mockCustomerMaybeSingle,
  mockLedgerLimit,
  mockRpcOrThrow,
  mockGetBillingState,
  mockNotifyLimitOnce,
} = vi.hoisted(() => ({
  mockCapMaybeSingle: vi.fn(),
  mockCustomerMaybeSingle: vi.fn(),
  mockLedgerLimit: vi.fn(),
  mockRpcOrThrow: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockNotifyLimitOnce: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "billing_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: mockCapMaybeSingle }) }) };
      }
      if (table === "customers") {
        return { select: () => ({ eq: () => ({ maybeSingle: mockCustomerMaybeSingle }) }) };
      }
      // managed_spend_ledger
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: mockLedgerLimit }) }) }) }),
        }),
      };
    },
  },
}));
vi.mock("@/lib/supabase/rpc", () => ({ rpcOrThrow: mockRpcOrThrow }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/billing/limit-notifications", () => ({
  notifyBillingLimit: mockNotifyLimitOnce,
  NOTIFICATION_KIND: {
    pointsLimit: "points_limit",
    overageLimit: "overage_limit",
    overageWarning: "overage_warning",
    managedSpendLimit: "managed_spend_limit",
    managedPaymentFailed: "managed_payment_failed",
    optimizationRunsLimit: "optimization_runs_limit",
  },
}));

import {
  getEffectiveManagedCap,
  getManagedSpendTotal,
  getManagedUninvoicedTotal,
  isManagedPaymentBlocked,
  paymentMethodFailing,
  getManagedSpendEntries,
  reserveManagedSpend,
  notifyManagedCapReached,
  notifyManagedPaymentFailed,
} from "../managed-spend";
import { PLANS } from "../plans";

beforeEach(() => vi.clearAllMocks());

describe("getEffectiveManagedCap", () => {
  it("uses the Team's override when set", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockCapMaybeSingle.mockResolvedValue({ data: { managed_spend_cap_usd: "40" }, error: null });
    const cap = await getEffectiveManagedCap("org_1");
    expect(cap).toEqual({ capUsd: 40, isDefault: false, plan: "builder" });
  });

  it("falls back to the plan default when no override row exists", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockCapMaybeSingle.mockResolvedValue({ data: null, error: null });
    const cap = await getEffectiveManagedCap("org_1");
    expect(cap).toEqual({ capUsd: PLANS.builder.defaultManagedSpendCapUsd, isDefault: true, plan: "builder" });
  });

  it("is null for a Free Team (no managed spend at all)", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockCapMaybeSingle.mockResolvedValue({ data: null, error: null });
    const cap = await getEffectiveManagedCap("org_1");
    expect(cap).toEqual({ capUsd: null, isDefault: true, plan: "free" });
  });

  it("throws on a read error", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockCapMaybeSingle.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(getEffectiveManagedCap("org_1")).rejects.toThrow("db down");
  });
});

describe("getManagedSpendTotal / getManagedUninvoicedTotal", () => {
  it("returns the RPC total, defaulting a null to zero", async () => {
    mockRpcOrThrow.mockResolvedValue(null);
    expect(await getManagedSpendTotal("org_1", "2026-06-01T00:00:00.000Z")).toBe(0);
  });

  it("returns the numeric total", async () => {
    mockRpcOrThrow.mockResolvedValue("12.5");
    expect(await getManagedSpendTotal("org_1", "2026-06-01T00:00:00.000Z")).toBe(12.5);
  });

  it("uninvoiced total mirrors the same contract via its own RPC", async () => {
    mockRpcOrThrow.mockResolvedValue(3.2);
    expect(await getManagedUninvoicedTotal("org_1", "2026-06-01T00:00:00.000Z")).toBe(3.2);
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "managed_uninvoiced_total",
      expect.objectContaining({ p_org_id: "org_1" })
    );
  });

  it("defaults a null uninvoiced total to zero", async () => {
    mockRpcOrThrow.mockResolvedValue(null);
    expect(await getManagedUninvoicedTotal("org_1", "2026-06-01T00:00:00.000Z")).toBe(0);
  });
});

describe("isManagedPaymentBlocked", () => {
  it("is false when the mirror shows no failure timestamp", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: { managed_payment_failed_at: null }, error: null });
    expect(await isManagedPaymentBlocked("org_1")).toBe(false);
  });

  it("is true once the mirror is tripped", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({
      data: { managed_payment_failed_at: "2026-06-01T00:00:00.000Z" },
      error: null,
    });
    expect(await isManagedPaymentBlocked("org_1")).toBe(true);
  });

  it("fails closed (blocked) on a read error", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: null, error: new Error("db down") });
    expect(await isManagedPaymentBlocked("org_1")).toBe(true);
  });
});

describe("paymentMethodFailing", () => {
  it("is true when the managed mirror is tripped, even with an active subscription", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({
      data: { managed_payment_failed_at: "2026-06-01T00:00:00.000Z" },
      error: null,
    });
    mockGetBillingState.mockResolvedValue({ status: "active" });
    expect(await paymentMethodFailing("org_1")).toBe(true);
  });

  it("is true when the subscription itself is past_due or unpaid", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: { managed_payment_failed_at: null }, error: null });
    mockGetBillingState.mockResolvedValue({ status: "past_due" });
    expect(await paymentMethodFailing("org_1")).toBe(true);

    mockGetBillingState.mockResolvedValue({ status: "unpaid" });
    expect(await paymentMethodFailing("org_1")).toBe(true);
  });

  it("is false for a healthy, active Team", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: { managed_payment_failed_at: null }, error: null });
    mockGetBillingState.mockResolvedValue({ status: "active" });
    expect(await paymentMethodFailing("org_1")).toBe(false);
  });
});

describe("getManagedSpendEntries", () => {
  it("maps ledger rows to the display shape", async () => {
    mockLedgerLimit.mockResolvedValue({
      data: [
        {
          id: "e1",
          provider: "anthropic",
          model: "claude",
          input_tokens: "100",
          output_tokens: "50",
          amount_usd: "0.002",
          call_kind: "judge",
          created_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const entries = await getManagedSpendEntries("org_1", "2026-06-01T00:00:00.000Z");
    expect(entries).toEqual([
      {
        id: "e1",
        provider: "anthropic",
        model: "claude",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.002,
        callKind: "judge",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
  });

  it("keeps null token counts as null (not coerced to 0)", async () => {
    mockLedgerLimit.mockResolvedValue({
      data: [
        {
          id: "e2",
          provider: null,
          model: null,
          input_tokens: null,
          output_tokens: null,
          amount_usd: "0.5",
          call_kind: null,
          created_at: "2026-06-02T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const entries = await getManagedSpendEntries("org_1", "2026-06-01T00:00:00.000Z");
    expect(entries[0].inputTokens).toBeNull();
    expect(entries[0].outputTokens).toBeNull();
  });

  it("defaults to an empty list and throws on error", async () => {
    mockLedgerLimit.mockResolvedValue({ data: null, error: null });
    expect(await getManagedSpendEntries("org_1", "2026-06-01T00:00:00.000Z")).toEqual([]);

    mockLedgerLimit.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(getManagedSpendEntries("org_1", "2026-06-01T00:00:00.000Z")).rejects.toThrow("db down");
  });
});

describe("reserveManagedSpend", () => {
  it("reserves and returns the committed total", async () => {
    mockRpcOrThrow.mockResolvedValue([{ reserved: true, committed_usd: "12.34" }]);
    const result = await reserveManagedSpend(
      "org_1",
      { evalRunId: "run_1" },
      1.5,
      25,
      40,
      { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" }
    );
    expect(result).toEqual({ reserved: true, committedUsd: 12.34 });
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "reserve_managed_spend",
      expect.objectContaining({
        p_org_id: "org_1",
        p_eval_run_id: "run_1",
        p_opt_run_id: null,
        p_markup_pct: 40,
      })
    );
  });

  it("defaults an unreserved/empty row to zero committed", async () => {
    mockRpcOrThrow.mockResolvedValue(null);
    const result = await reserveManagedSpend(
      "org_1",
      { optRunId: "opt_1" },
      1,
      25,
      40,
      { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" }
    );
    expect(result).toEqual({ reserved: false, committedUsd: 0 });
  });
});

describe("notifyManagedCapReached / notifyManagedPaymentFailed", () => {
  it("throttles the cap-reached email through notifyBillingLimit", async () => {
    await notifyManagedCapReached("org_1", 25, "2026-06-01T00:00:00.000Z");
    expect(mockNotifyLimitOnce).toHaveBeenCalledWith(
      "managed_spend_limit",
      "org_1",
      "2026-06-01T00:00:00.000Z",
      { capUsd: 25 }
    );
  });

  it("throttles the payment-failed email through notifyBillingLimit", async () => {
    await notifyManagedPaymentFailed("org_1", 10, "2026-06-01T00:00:00.000Z");
    expect(mockNotifyLimitOnce).toHaveBeenCalledWith(
      "managed_payment_failed",
      "org_1",
      "2026-06-01T00:00:00.000Z",
      { amountUsd: 10 }
    );
  });
});
