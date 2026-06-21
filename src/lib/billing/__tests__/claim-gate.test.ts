import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));

// --- Builder (shared chainable supabaseAdmin stub) ---
// maybeSingle reads resolve from a queue in call order: run → existingReserve → rubric →
// schedule → connection. The eval_run_rows count query awaits the chain directly (→ _result).
interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  eq: Mock;
  limit: Mock;
  maybeSingle: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

const builder: MockBuilder = {
  _result: { count: 1, error: null },
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  limit: vi.fn(),
  maybeSingle: vi.fn(),
  then: (resolve) => resolve(builder._result),
};
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Billing seams (mocked; estimateManagedSpendUsd + PLANS stay real so the test pins the
// real estimate math and the real free/paid markup) ---
const mockSeatCap = vi.fn();
vi.mock("@/lib/billing/seats", () => ({ getSeatCapState: mockSeatCap }));

const mockReservePoints = vi.fn();
const mockResolvePeriod = vi.fn();
vi.mock("@/lib/billing/ledger", () => ({
  reserveEvalRunPoints: mockReservePoints,
  resolvePointPeriod: mockResolvePeriod,
}));

vi.mock("@/lib/billing/limit-notifications", () => ({ notifyLimitOnce: vi.fn() }));
vi.mock("@/lib/billing/overage", () => ({ notifyCapReached: vi.fn() }));
vi.mock("@/lib/email/templates/points-limit", () => ({ pointsLimitEmailHtml: vi.fn() }));
vi.mock("@/lib/email/templates/seat-cap", () => ({ seatCapEmailHtml: vi.fn() }));

const mockResolveKeyMode = vi.fn();
vi.mock("@/lib/llm/key-gate", () => ({
  resolveKeyModeForEstimate: mockResolveKeyMode,
  KEY_MODE: { byo: "byo", managed: "managed", blocked: "blocked" },
}));

const mockGetCap = vi.fn();
const mockReserveManaged = vi.fn();
const mockNotifyManagedCap = vi.fn();
vi.mock("@/lib/billing/managed-spend", () => ({
  getEffectiveManagedCap: mockGetCap,
  reserveManagedSpend: mockReserveManaged,
  notifyManagedCapReached: mockNotifyManagedCap,
}));

const TARGET_MODEL = "claude-haiku-4-5-20251001";

// Queue the 5 maybeSingle reads for a scheduled run, in claim-gate's call order.
function queueRun(opts: { agentKind: string; targetModel: string | null }) {
  builder.maybeSingle
    .mockResolvedValueOnce({ data: { id: "run_1", rubric_id: "rubric_1", schedule_id: "sched_1" }, error: null })
    .mockResolvedValueOnce({ data: null, error: null }) // no existing point reserve
    .mockResolvedValueOnce({ data: { org_id: "org_1", criteria: [{ name: "Accuracy" }] }, error: null })
    .mockResolvedValueOnce({ data: { connection_id: "conn_1" }, error: null })
    .mockResolvedValueOnce({ data: { agent_kind: opts.agentKind, target_model: opts.targetModel }, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of ["from", "select", "eq", "limit"] as const) builder[m].mockReturnValue(builder);
  builder._result = { count: 1, error: null }; // eval_run_rows count
  mockSeatCap.mockResolvedValue({ violated: false, memberCount: 1, seatLimit: null });
  mockResolvePeriod.mockResolvedValue({ start: new Date("2026-06-01T00:00:00.000Z") });
  mockReservePoints.mockResolvedValue({
    reserved: true,
    balance: 100,
    plan: "builder",
    capUsd: null,
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
    paymentFailing: false,
  });
  mockResolveKeyMode.mockResolvedValue("managed");
  mockGetCap.mockResolvedValue({ capUsd: 1000 });
  mockReserveManaged.mockResolvedValue({ reserved: true });
});

describe("gateScheduledRunBilling — Managed Agent spend (#292)", () => {
  it("reserves the judge + target-model managed spend for a managed-agent scheduled run", async () => {
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).toHaveBeenCalledTimes(1);
    // The reserved estimate (3rd arg) is positive — it includes the dominant target-model term.
    const estimate = mockReserveManaged.mock.calls[0][2] as number;
    expect(estimate).toBeGreaterThan(0);
    expect(mockReserveManaged.mock.calls[0][1]).toEqual({ evalRunId: "run_1" });
  });

  it("refuses with reason 'managed_cap' when the managed reserve would exceed the cap", async () => {
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    mockReserveManaged.mockResolvedValue({ reserved: false });
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: false, reason: "managed_cap" });
    expect(mockNotifyManagedCap).toHaveBeenCalled();
  });

  it("reserves NO managed spend for an external-agent scheduled run (unchanged)", async () => {
    queueRun({ agentKind: "external", targetModel: null });
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).not.toHaveBeenCalled();
  });

  it("reserves NO managed spend for a managed agent on a BYO-key Team (keyMode byo)", async () => {
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    mockResolveKeyMode.mockResolvedValue("byo");
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).not.toHaveBeenCalled();
  });
});
