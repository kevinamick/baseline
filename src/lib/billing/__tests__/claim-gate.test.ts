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
// claim-gate now delegates to the Run Gate (../run-gate), which ALSO imports getSeatCapState /
// reserveEvalRunPoints / etc. from these same module paths — vi.mock intercepts by resolved
// specifier, not by importer, so one mock here covers both claim-gate.ts's own calls and the
// Run Gate's internal ones.
const mockSeatCap = vi.fn();
vi.mock("@/lib/billing/seats", async (importOriginal) => ({
  // seatCapError is pure — keep the real one (the Run Gate's preflight refusal message uses it).
  ...(await importOriginal<typeof import("@/lib/billing/seats")>()),
  getSeatCapState: mockSeatCap,
}));

const mockReservePoints = vi.fn();
const mockResolvePeriod = vi.fn();
vi.mock("@/lib/billing/ledger", () => ({
  reserveEvalRunPoints: mockReservePoints,
  resolvePointPeriod: mockResolvePeriod,
}));

vi.mock("@/lib/billing/limit-notifications", () => ({
  notifyLimitOnce: vi.fn(),
  notifyPointsLimitOnce: vi.fn(),
}));
vi.mock("@/lib/billing/overage", () => ({ notifyCapReached: vi.fn(), maybeWarnNearCap: vi.fn() }));
vi.mock("@/lib/email/templates/points-limit", () => ({ pointsLimitEmailHtml: vi.fn() }));
vi.mock("@/lib/email/templates/seat-cap", () => ({ seatCapEmailHtml: vi.fn() }));
vi.mock("@/lib/analytics/server", () => ({ track: vi.fn() }));

const mockResolveKeyMode = vi.fn(); // the TARGET's Anthropic key mode (managed agent)
const mockResolveJudgeKeyMode = vi.fn(); // the JUDGE's key mode (any-BYO-aware)
vi.mock("@/lib/llm/key-gate", () => ({
  resolveKeyModeForEstimate: mockResolveKeyMode,
  resolveJudgeKeyModeForEstimate: mockResolveJudgeKeyMode,
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
    .mockResolvedValueOnce({
      data: { id: "run_1", rubric_id: "rubric_1", schedule_id: "sched_1", created_by: "user_1" },
      error: null,
    })
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
  mockResolveJudgeKeyMode.mockResolvedValue("managed");
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

  it("refuses a Free/unpaid Team a managed-agent run even with a BYO key (paid-plan only)", async () => {
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    // Plan floors to free (downgrade after a paid schedule was created, or a trialing/unrecognized
    // price). managedMarkupPct is null for free → refuse before any reserve, regardless of keyMode.
    mockReservePoints.mockResolvedValue({
      reserved: true,
      balance: 100,
      plan: "free",
      capUsd: null,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      paymentFailing: false,
    });
    mockResolveKeyMode.mockResolvedValue("byo"); // has a BYO key — would otherwise slip through
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: false, reason: "managed_not_paid" });
    expect(mockReserveManaged).not.toHaveBeenCalled();
  });

  it("refuses with reason 'managed_cap' when the managed reserve would exceed the cap", async () => {
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    mockReserveManaged.mockResolvedValue({ reserved: false });
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: false, reason: "managed_cap" });
    expect(mockNotifyManagedCap).toHaveBeenCalled();
  });

  it("reserves the JUDGE managed spend for a dataset scheduled run when the judge is managed (#358)", async () => {
    queueRun({ agentKind: "dataset", targetModel: null });
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    // The managed judge term is reserved even without a Managed Agent target (#358): without it the
    // worker would judge on the managed key with no reservation and never meter the spend.
    expect(mockReserveManaged).toHaveBeenCalledTimes(1);
    expect(mockReserveManaged.mock.calls[0][1]).toEqual({ evalRunId: "run_1" });
    expect(mockReserveManaged.mock.calls[0][2] as number).toBeGreaterThan(0);
  });

  it("reserves the JUDGE managed spend for an external-agent scheduled run when the judge is managed (#358)", async () => {
    queueRun({ agentKind: "external", targetModel: null });
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).toHaveBeenCalledTimes(1);
  });

  it("reserves NO managed spend for a dataset/external run when the judge is BYO", async () => {
    queueRun({ agentKind: "dataset", targetModel: null });
    mockResolveJudgeKeyMode.mockResolvedValue("byo"); // the Team has a BYO key → judge runs BYO
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).not.toHaveBeenCalled();
  });

  it("reserves ONLY the target term for a managed agent whose judge is BYO on a non-Anthropic key (#358)", async () => {
    // The Team brought a BYO OpenAI key (judge runs BYO OpenAI) but has no Anthropic key, so the
    // Managed Agent's Anthropic target still runs on the managed key. Judge term skipped, target
    // term reserved — the app must not over-reserve the judge, nor under-reserve the target.
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    mockResolveJudgeKeyMode.mockResolvedValue("byo"); // judge BYO (OpenAI)
    mockResolveKeyMode.mockResolvedValue("managed"); // target Anthropic → managed
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).toHaveBeenCalledTimes(1);
    expect(mockReserveManaged.mock.calls[0][2] as number).toBeGreaterThan(0);
  });

  it("reserves NO managed spend for a managed agent on a fully BYO-Anthropic Team (judge + target byo)", async () => {
    queueRun({ agentKind: "managed", targetModel: TARGET_MODEL });
    mockResolveJudgeKeyMode.mockResolvedValue("byo");
    mockResolveKeyMode.mockResolvedValue("byo");
    const { gateScheduledRunBilling } = await import("../claim-gate");
    const result = await gateScheduledRunBilling("run_1");

    expect(result).toEqual({ allowed: true });
    expect(mockReserveManaged).not.toHaveBeenCalled();
  });

  it("throws when the eval_run_rows count query fails — prevents billing bypass via zero-cost reserve", async () => {
    // Only need run/reserve/rubric in the queue; the error fires before schedule/connection.
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: "run_1", rubric_id: "rubric_1", schedule_id: "sched_1" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { org_id: "org_1", criteria: [{ name: "Accuracy" }] }, error: null });
    builder._result = { count: null, error: { message: "DB error" } };
    const { gateScheduledRunBilling } = await import("../claim-gate");
    await expect(gateScheduledRunBilling("run_1")).rejects.toEqual({ message: "DB error" });
    // The point reserve must NOT be called — a zero-cost reserve would allow the run for free.
    expect(mockReservePoints).not.toHaveBeenCalled();
  });
});
