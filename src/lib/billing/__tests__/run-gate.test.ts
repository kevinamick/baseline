import { describe, it, expect, vi, beforeEach } from "vitest";

// The logging/analytics modules carry `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

// seats.ts is imported with importOriginal below (to keep seatCapError's real copy), which
// transitively touches supabaseAdmin (a real client construction needs env vars this suite
// doesn't set) — stub it out; nothing here exercises the real client.
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

// --- Mocks over the Run Gate's own dependency seams — plain inputs in, plain
// results out, so these are direct unit tests of the gate's own logic (not an
// integration test of the ledger/managed-spend SQL, which is covered elsewhere). ---

const mockGetSeatCapState = vi.fn();
vi.mock("@/lib/billing/seats", async (importOriginal) => ({
  // seatCapError is pure — keep the real one so the refusal message is pinned.
  ...(await importOriginal<typeof import("@/lib/billing/seats")>()),
  getSeatCapState: mockGetSeatCapState,
}));

const mockEvalRunBlockedForMissingKey = vi.fn();
const mockManagedRunBlockedForPayment = vi.fn();
const mockResolveKeyModeForEstimate = vi.fn();
const mockResolveJudgeKeyModeForEstimate = vi.fn();
vi.mock("@/lib/llm/key-gate", () => ({
  evalRunBlockedForMissingKey: mockEvalRunBlockedForMissingKey,
  managedRunBlockedForPayment: mockManagedRunBlockedForPayment,
  resolveKeyModeForEstimate: mockResolveKeyModeForEstimate,
  resolveJudgeKeyModeForEstimate: mockResolveJudgeKeyModeForEstimate,
  KEY_MODE: { byo: "byo", managed: "managed", blocked: "blocked" },
}));

const mockReserveEvalRunPoints = vi.fn();
vi.mock("@/lib/billing/ledger", () => ({ reserveEvalRunPoints: mockReserveEvalRunPoints }));

const mockNotifyPointsLimitOnce = vi.fn();
const mockNotifyLimitOnce = vi.fn();
vi.mock("@/lib/billing/limit-notifications", () => ({
  notifyPointsLimitOnce: mockNotifyPointsLimitOnce,
  notifyLimitOnce: mockNotifyLimitOnce,
}));

const mockMaybeWarnNearCap = vi.fn();
const mockNotifyCapReached = vi.fn();
vi.mock("@/lib/billing/overage", () => ({
  maybeWarnNearCap: mockMaybeWarnNearCap,
  notifyCapReached: mockNotifyCapReached,
}));

const mockEstimateManagedSpendUsd = vi.fn();
vi.mock("@/lib/billing/managed-spend-estimate", () => ({
  estimateManagedSpendUsd: mockEstimateManagedSpendUsd,
}));

const mockGetEffectiveManagedCap = vi.fn();
const mockReserveManagedSpend = vi.fn();
const mockNotifyManagedCapReached = vi.fn();
vi.mock("@/lib/billing/managed-spend", () => ({
  getEffectiveManagedCap: mockGetEffectiveManagedCap,
  reserveManagedSpend: mockReserveManagedSpend,
  notifyManagedCapReached: mockNotifyManagedCapReached,
}));

const mockTrack = vi.fn();
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));

// #382: the Optimization Run dual-meter reserve kinds' own seams.
const mockReserveOptimizationRun = vi.fn();
const mockReserveOptimizationPoints = vi.fn();
vi.mock("@/lib/billing/allowance", () => ({
  reserveOptimizationRun: mockReserveOptimizationRun,
  reserveOptimizationPoints: mockReserveOptimizationPoints,
}));

// --- Fixtures ---

const BASE_RESERVE_REQUEST = {
  runKind: "eval" as const,
  orgId: "org_abc",
  userId: "user_abc",
  runId: "run_1",
  pointReserve: {
    kind: "eval_points" as const,
    pointCost: 50,
    metadata: { row_count: 2, criteria_count: 3, per_row_cost: 25 },
  },
  managedSpendRef: { evalRunId: "run_1" },
};

function callbacks() {
  return {
    deleteRun: vi.fn().mockResolvedValue(undefined),
    rollbackReservations: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSeatCapState.mockResolvedValue({ violated: false, memberCount: 1, seatLimit: null });
  mockEvalRunBlockedForMissingKey.mockResolvedValue(false);
  mockManagedRunBlockedForPayment.mockResolvedValue(false);
  mockResolveKeyModeForEstimate.mockResolvedValue("byo");
  mockResolveJudgeKeyModeForEstimate.mockResolvedValue("byo");
  mockReserveEvalRunPoints.mockResolvedValue({
    reserved: true,
    balance: 1_000,
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
    capUsd: null,
    plan: "builder",
    paymentFailing: false,
  });
  mockNotifyPointsLimitOnce.mockResolvedValue(undefined);
  mockMaybeWarnNearCap.mockResolvedValue(undefined);
  mockNotifyCapReached.mockResolvedValue(undefined);
  mockEstimateManagedSpendUsd.mockReturnValue(null);
  mockGetEffectiveManagedCap.mockResolvedValue({ capUsd: 25, isDefault: true, plan: "builder" });
  mockReserveManagedSpend.mockResolvedValue({ reserved: true, committedUsd: 0 });
  mockNotifyManagedCapReached.mockResolvedValue(undefined);
  mockNotifyLimitOnce.mockResolvedValue(undefined);
  mockReserveOptimizationRun.mockResolvedValue({
    reserved: true,
    remaining: 14,
    periodStart: "2026-06-01T00:00:00.000Z",
    plan: "builder",
  });
  mockReserveOptimizationPoints.mockResolvedValue({
    reserved: true,
    balance: 4_000,
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
    capUsd: null,
    plan: "builder",
    paymentFailing: false,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- checkRunPreflight ---

describe("checkRunPreflight", () => {
  it("refuses when the team is over its seat cap, before any other check", async () => {
    mockGetSeatCapState.mockResolvedValue({ violated: true, memberCount: 2, seatLimit: 1 });
    const { checkRunPreflight, RUN_KIND } = await import("../run-gate");
    const result = await checkRunPreflight({
      runKind: RUN_KIND.eval,
      orgId: "org_abc",
      requireProviderKeyForFreePlan: true,
      managedPaymentCheckProviders: ["anthropic"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.kind).toBe("seat_cap");
      expect(result.refusal.error).toContain("2 members");
    }
    expect(mockEvalRunBlockedForMissingKey).not.toHaveBeenCalled();
    expect(mockManagedRunBlockedForPayment).not.toHaveBeenCalled();
  });

  it("refuses a keyless Free Team when requireProviderKeyForFreePlan is set (#184)", async () => {
    mockEvalRunBlockedForMissingKey.mockResolvedValue(true);
    const { checkRunPreflight, RUN_KIND } = await import("../run-gate");
    const result = await checkRunPreflight({
      runKind: RUN_KIND.eval,
      orgId: "org_abc",
      requireProviderKeyForFreePlan: true,
      managedPaymentCheckProviders: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.kind).toBe("missing_key");
      expect(result.refusal.error).toContain("Add an LLM provider key");
    }
  });

  it("skips the missing-key gate when requireProviderKeyForFreePlan is false", async () => {
    mockEvalRunBlockedForMissingKey.mockResolvedValue(true);
    const { checkRunPreflight, RUN_KIND } = await import("../run-gate");
    const result = await checkRunPreflight({
      runKind: RUN_KIND.eval,
      orgId: "org_abc",
      requireProviderKeyForFreePlan: false,
      managedPaymentCheckProviders: [],
    });
    expect(result.ok).toBe(true);
    expect(mockEvalRunBlockedForMissingKey).not.toHaveBeenCalled();
  });

  it("refuses when ANY declared managed-payment provider is blocked", async () => {
    mockManagedRunBlockedForPayment.mockImplementation(async (_orgId, provider) => provider === "openai");
    const { checkRunPreflight, RUN_KIND } = await import("../run-gate");
    const result = await checkRunPreflight({
      runKind: RUN_KIND.eval,
      orgId: "org_abc",
      requireProviderKeyForFreePlan: false,
      managedPaymentCheckProviders: ["anthropic", "openai"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.kind).toBe("managed_payment_failing");
      expect(result.refusal.error).toContain("payment failed");
    }
    expect(mockManagedRunBlockedForPayment).toHaveBeenCalledWith("org_abc", "anthropic");
    expect(mockManagedRunBlockedForPayment).toHaveBeenCalledWith("org_abc", "openai");
  });

  it("passes when every check clears", async () => {
    const { checkRunPreflight, RUN_KIND } = await import("../run-gate");
    const result = await checkRunPreflight({
      runKind: RUN_KIND.eval,
      orgId: "org_abc",
      requireProviderKeyForFreePlan: true,
      managedPaymentCheckProviders: ["anthropic"],
    });
    expect(result).toEqual({ ok: true });
  });
});

// --- reserveRunOrRefuse: Eval Point reserve ---

describe("reserveRunOrRefuse — eval_points", () => {
  it("reserves the run's exact point cost and returns the reservation context", async () => {
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(result).toEqual({
      ok: true,
      plan: "builder",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    expect(mockReserveEvalRunPoints).toHaveBeenCalledWith("org_abc", "run_1", 50, {
      row_count: 2,
      criteria_count: 3,
      per_row_cost: 25,
    });
  });

  it("fails closed and rolls back when the reserve call itself throws", async () => {
    mockReserveEvalRunPoints.mockRejectedValue(new Error("ledger unreachable"));
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: cb });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error: "Couldn't check your team's Eval Point balance. Please try again.",
      },
    });
    expect(cb.rollbackReservations).toHaveBeenCalledTimes(1);
    expect(cb.deleteRun).not.toHaveBeenCalled();
  });

  it("payment-failing wins over the cap message (#215) and skips the cap/points notifications", async () => {
    mockReserveEvalRunPoints.mockResolvedValue({
      reserved: false,
      balance: 5,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 100,
      plan: "builder",
      paymentFailing: true,
    });
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: cb });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error:
          "Eval Point overage is paused because your team's payment method is failing — update your card in Billing to run beyond your included Eval Points. This run needs 50; 5 remain this period.",
        insufficientPoints: { needed: 50, remaining: 5 },
      },
    });
    expect(cb.deleteRun).toHaveBeenCalledTimes(1);
    expect(cb.rollbackReservations).not.toHaveBeenCalled();
    expect(mockNotifyCapReached).not.toHaveBeenCalled();
    expect(mockNotifyPointsLimitOnce).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.points_limit_hit",
        props: { team_id: "org_abc", needed: 50, remaining: 5, cap_usd: 100 },
      }),
      { userId: "user_abc" }
    );
  });

  it("refuses with the overage-cap message and notifies once when a cap is set (not payment-failing)", async () => {
    mockReserveEvalRunPoints.mockResolvedValue({
      reserved: false,
      balance: 5,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 100,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: callbacks() });
    expect(result).toMatchObject({
      ok: false,
      refusal: { kind: "insufficient_points", insufficientPoints: { needed: 50, remaining: 5 } },
    });
    // Pins the ICU-rendered en copy byte-for-byte (e2e overage.spec asserts
    // this exact phrasing, dollar sign included).
    if (!result.ok) {
      expect(result.refusal.error).toBe(
        "Not enough Eval Points: this run needs 50 and would take your team past its $100 monthly overage cap.",
      );
      expect(result.refusal.messageKey).toBe("pointsCapBlocked");
    }
    expect(mockNotifyCapReached).toHaveBeenCalledWith("org_abc", 100, "2026-06-01T00:00:00.000Z");
    expect(mockNotifyPointsLimitOnce).not.toHaveBeenCalled();
  });

  it("refuses with the plain points message and notifies once when there's no cap", async () => {
    mockReserveEvalRunPoints.mockResolvedValue({
      reserved: false,
      balance: 5,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: null,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: callbacks() });
    expect(result).toMatchObject({
      ok: false,
      refusal: { kind: "insufficient_points", insufficientPoints: { needed: 50, remaining: 5 } },
    });
    if (!result.ok) expect(result.refusal.error).toBe("Not enough Eval Points: this run needs 50, but only 5 remain this period.");
    expect(mockNotifyPointsLimitOnce).toHaveBeenCalledWith({
      orgId: "org_abc",
      periodStart: "2026-06-01T00:00:00.000Z",
      neededPoints: 50,
      remainingPoints: 5,
    });
    expect(mockNotifyCapReached).not.toHaveBeenCalled();
  });

  it("clamps a negative balance to zero in the refusal numbers", async () => {
    mockReserveEvalRunPoints.mockResolvedValue({
      reserved: false,
      balance: -40,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: null,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: callbacks() });
    expect(result).toMatchObject({ refusal: { insufficientPoints: { remaining: 0 } } });
  });

  it("warns near-cap only when funded into negative (cap-backed overage) balance", async () => {
    mockReserveEvalRunPoints.mockResolvedValue({
      reserved: true,
      balance: -5,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 100,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: callbacks() });
    expect(mockMaybeWarnNearCap).toHaveBeenCalledWith("org_abc", {
      capUsd: 100,
      plan: "builder",
      periodStart: "2026-06-01T00:00:00.000Z",
    });
  });

  it("skips the near-cap warning when the reserve left a non-negative balance", async () => {
    const { reserveRunOrRefuse } = await import("../run-gate");
    await reserveRunOrRefuse({ ...BASE_RESERVE_REQUEST, managedSpendTerms: [], callbacks: callbacks() });
    expect(mockMaybeWarnNearCap).not.toHaveBeenCalled();
  });
});

// --- reserveRunOrRefuse: Managed Spend Cap reserve ---

describe("reserveRunOrRefuse — Managed Spend Cap", () => {
  const judgeTerm = {
    keyModeStrategy: "judge_any_byo" as const,
    provider: "anthropic" as const,
    model: "claude-judge",
    volume: 2,
    criteriaCount: 3,
  };

  it("reserves no managed spend and never checks the cap when every term resolves BYO (#358)", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("byo");
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [judgeTerm],
      callbacks: callbacks(),
    });
    expect(result.ok).toBe(true);
    expect(mockGetEffectiveManagedCap).not.toHaveBeenCalled();
    expect(mockReserveManagedSpend).not.toHaveBeenCalled();
  });

  it("uses resolveJudgeKeyModeForEstimate for a judgeAnyByo term and resolveKeyModeForEstimate for a perProvider term", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("byo");
    mockResolveKeyModeForEstimate.mockResolvedValue("byo");
    const { reserveRunOrRefuse } = await import("../run-gate");
    await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [
        judgeTerm,
        { keyModeStrategy: "per_provider" as const, provider: "openai" as const, model: "gpt-target", volume: 2, criteriaCount: 1 },
      ],
      callbacks: callbacks(),
    });
    expect(mockResolveJudgeKeyModeForEstimate).toHaveBeenCalledWith("org_abc");
    expect(mockResolveKeyModeForEstimate).toHaveBeenCalledWith("org_abc", "openai");
  });

  it("reserves the managed estimate when the judge resolves managed, and returns ok on success", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("managed");
    mockEstimateManagedSpendUsd.mockReturnValue(1.23);
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [judgeTerm],
      callbacks: callbacks(),
    });
    expect(result).toEqual({
      ok: true,
      plan: "builder",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    expect(mockReserveManagedSpend).toHaveBeenCalledWith(
      "org_abc",
      { evalRunId: "run_1" },
      1.23,
      25,
      40,
      { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" }
    );
  });

  it("sums multiple managed terms into a single reserve call", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("managed");
    mockResolveKeyModeForEstimate.mockResolvedValue("managed");
    mockEstimateManagedSpendUsd.mockReturnValueOnce(1).mockReturnValueOnce(2);
    const { reserveRunOrRefuse } = await import("../run-gate");
    await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [
        judgeTerm,
        { keyModeStrategy: "per_provider" as const, provider: "anthropic" as const, model: "target", volume: 2, criteriaCount: 1 },
      ],
      callbacks: callbacks(),
    });
    expect(mockReserveManagedSpend.mock.calls[0][2]).toBe(3);
  });

  it("rolls back and refuses when the managed reserve would exceed the cap", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("managed");
    mockEstimateManagedSpendUsd.mockReturnValue(5);
    mockReserveManagedSpend.mockResolvedValue({ reserved: false, committedUsd: 25 });
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [judgeTerm],
      callbacks: cb,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.kind).toBe("managed_cap_exceeded");
      expect(result.refusal.error).toContain("managed spend cap");
    }
    expect(cb.rollbackReservations).toHaveBeenCalledTimes(1);
    expect(mockNotifyManagedCapReached).toHaveBeenCalledWith("org_abc", 25, "2026-06-01T00:00:00.000Z");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.managed_spend_limit_hit",
        props: { team_id: "org_abc", estimate_usd: 5, cap_usd: 25 },
      }),
      { userId: "user_abc" }
    );
  });

  it("fails closed and rolls back when the cap check itself errors", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("managed");
    mockEstimateManagedSpendUsd.mockReturnValue(5);
    mockGetEffectiveManagedCap.mockRejectedValue(new Error("db down"));
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [judgeTerm],
      callbacks: cb,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "managed_cap_exceeded",
        error: "Couldn't check your team's managed spend cap. Please try again.",
      },
    });
    expect(cb.rollbackReservations).toHaveBeenCalledTimes(1);
  });

  it("skips the reserve when the plan has no cap or markup configured (e.g. Free/BYO-only)", async () => {
    mockResolveJudgeKeyModeForEstimate.mockResolvedValue("managed");
    mockEstimateManagedSpendUsd.mockReturnValue(5);
    mockGetEffectiveManagedCap.mockResolvedValue({ capUsd: null, isDefault: true, plan: "builder" });
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_RESERVE_REQUEST,
      managedSpendTerms: [judgeTerm],
      callbacks: callbacks(),
    });
    expect(result.ok).toBe(true);
    expect(mockReserveManagedSpend).not.toHaveBeenCalled();
  });
});

// --- reserveRunOrRefuse: Optimization Run dual-meter (#382, ADR-0016) ---

const BASE_OPT_RESERVE_REQUEST = {
  runKind: "optimization" as const,
  orgId: "org_abc",
  userId: "user_abc",
  runId: "run_1",
  managedSpendRef: { optRunId: "run_1" },
};

describe("reserveRunOrRefuse — optimization_unit", () => {
  it("reserves one allowance unit and returns the reservation context", async () => {
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: {
        kind: "optimization_unit",
        period: {
          periodStart: "2026-06-01T00:00:00.000Z",
          periodEnd: "2026-07-01T00:00:00.000Z",
          included: 15,
          plan: "builder",
        },
      },
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(result).toEqual({
      ok: true,
      plan: "builder",
      periodStart: "2026-06-01T00:00:00.000Z",
      // reserveOptimizationRun doesn't echo periodEnd — the gate carries it from
      // the caller's own pre-resolved allowance snapshot instead.
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    expect(mockReserveOptimizationRun).toHaveBeenCalledWith("org_abc", "run_1", {
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      included: 15,
      plan: "builder",
    });
  });

  it("fails closed and rolls back when the reserve call itself throws", async () => {
    mockReserveOptimizationRun.mockRejectedValue(new Error("ledger unreachable"));
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: {
        kind: "optimization_unit",
        period: { periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-07-01T00:00:00.000Z", included: 15, plan: "builder" },
      },
      managedSpendTerms: [],
      callbacks: cb,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error: "Couldn't check your team's run allowance. Please try again.",
      },
    });
    expect(cb.rollbackReservations).toHaveBeenCalledTimes(1);
    expect(cb.deleteRun).not.toHaveBeenCalled();
  });

  it("refuses with the plain allowance-exhausted message and notifies once when a concurrent run took the last unit", async () => {
    mockReserveOptimizationRun.mockResolvedValue({
      reserved: false,
      remaining: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
      plan: "builder",
    });
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: {
        kind: "optimization_unit",
        period: { periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-07-01T00:00:00.000Z", included: 15, plan: "builder" },
      },
      managedSpendTerms: [],
      callbacks: cb,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "optimization_allowance_exhausted",
        error: "Your team has used all 15 Optimization Runs included this period.",
      },
    });
    // Nothing was reserved — delete outright, no settle/rollback needed.
    expect(cb.deleteRun).toHaveBeenCalledTimes(1);
    expect(cb.rollbackReservations).not.toHaveBeenCalled();
    expect(mockNotifyLimitOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_abc",
        kind: "optimization_runs_limit",
        periodStart: "2026-06-01T00:00:00.000Z",
      })
    );
  });
});

// --- reserveRunOrRefuse: Optimization Run dual-meter — Eval Points overage leg ---

describe("reserveRunOrRefuse — optimization_points", () => {
  const optPointReserve = {
    kind: "optimization_points" as const,
    pointCost: 400,
    included: 15,
    metadata: { criteria_count: 2, budget_rollouts: 20, per_rollout_cost: 20 },
  };

  it("reserves the run's worst-case point cost and returns the reservation context", async () => {
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(result).toEqual({
      ok: true,
      plan: "builder",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    expect(mockReserveOptimizationPoints).toHaveBeenCalledWith("org_abc", "run_1", 400, {
      criteria_count: 2,
      budget_rollouts: 20,
      per_rollout_cost: 20,
    });
  });

  it("fails closed and rolls back when the reserve call itself throws", async () => {
    mockReserveOptimizationPoints.mockRejectedValue(new Error("ledger unreachable"));
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: cb,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error: "Couldn't check your team's Eval Point balance. Please try again.",
      },
    });
    expect(cb.rollbackReservations).toHaveBeenCalledTimes(1);
    expect(cb.deleteRun).not.toHaveBeenCalled();
  });

  it("payment-failing wins over the cap message (#215) and skips the cap/points notifications", async () => {
    mockReserveOptimizationPoints.mockResolvedValue({
      reserved: false,
      balance: 100,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 500,
      plan: "builder",
      paymentFailing: true,
    });
    const cb = callbacks();
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: cb,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error:
          "Optimization Run overage is paused because your team's payment method is failing — update your card in Billing to start runs beyond the 15 included this period.",
      },
    });
    expect(cb.deleteRun).toHaveBeenCalledTimes(1);
    expect(cb.rollbackReservations).not.toHaveBeenCalled();
    expect(mockNotifyCapReached).not.toHaveBeenCalled();
    expect(mockNotifyLimitOnce).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.optimization_limit_hit",
        props: { team_id: "org_abc", included: 15, cap_usd: 500 },
      }),
      { userId: "user_abc" }
    );
  });

  it("refuses with the overage-cap message and notifies the cap-reached email (not the limit email) when a cap is set", async () => {
    mockReserveOptimizationPoints.mockResolvedValue({
      reserved: false,
      balance: 100,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 500,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error:
          "This optimization run needs 400 Eval Points, but your team has used its included Optimization Runs and another would take it past its $500 monthly overage cap.",
      },
    });
    expect(mockNotifyCapReached).toHaveBeenCalledWith("org_abc", 500, "2026-06-01T00:00:00.000Z");
    expect(mockNotifyLimitOnce).not.toHaveBeenCalled();
  });

  it("refuses with the plain points message and notifies the limit email once when there's no cap", async () => {
    mockReserveOptimizationPoints.mockResolvedValue({
      reserved: false,
      balance: 100,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: null,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    const result = await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error:
          "Your team has used its 15 included Optimization Runs, and this run's 400 Eval Points exceed your remaining balance. Add Eval Points or set an Overage Cap in Billing.",
      },
    });
    expect(mockNotifyLimitOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_abc",
        kind: "optimization_runs_limit",
        periodStart: "2026-06-01T00:00:00.000Z",
      })
    );
    expect(mockNotifyCapReached).not.toHaveBeenCalled();
  });

  it("warns near-cap only when funded into negative (cap-backed overage) balance", async () => {
    mockReserveOptimizationPoints.mockResolvedValue({
      reserved: true,
      balance: -5,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: 500,
      plan: "builder",
      paymentFailing: false,
    });
    const { reserveRunOrRefuse } = await import("../run-gate");
    await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(mockMaybeWarnNearCap).toHaveBeenCalledWith("org_abc", {
      capUsd: 500,
      plan: "builder",
      periodStart: "2026-06-01T00:00:00.000Z",
    });
  });

  it("skips the near-cap warning when the reserve left a non-negative balance", async () => {
    const { reserveRunOrRefuse } = await import("../run-gate");
    await reserveRunOrRefuse({
      ...BASE_OPT_RESERVE_REQUEST,
      pointReserve: optPointReserve,
      managedSpendTerms: [],
      callbacks: callbacks(),
    });
    expect(mockMaybeWarnNearCap).not.toHaveBeenCalled();
  });
});
