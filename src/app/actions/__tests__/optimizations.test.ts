import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
// Real (pure) estimate math + model constants — the managed-agent test pins the actual
// target-model term these produce, not a hand-copied number.
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import { ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  insert: Mock;
  upsert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  is: Mock;
  in: Mock;
  order: Mock;
  limit: Mock;
  single: Mock;
  maybeSingle: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

// --- Mocks ---

const mockGetAuthContext = vi.fn();
const mockTrack = vi.fn();
const mockWorkflowStart = vi.fn();
const mockTerminate = vi.fn();
const mockSignal = vi.fn();
const mockGetHandle = vi.fn(() => ({ terminate: mockTerminate, signal: mockSignal }));
const mockGetTemporalClient = vi.fn();
const mockInsertConnection = vi.fn();

const mockLogInfo = vi.fn();
const mockLogError = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: mockLogInfo, error: mockLogError, warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/temporal/client", () => ({ getTemporalClient: mockGetTemporalClient }));
vi.mock("@/lib/connections/create", () => ({ insertConnection: mockInsertConnection }));

// Allowance seams (#181) — SQL atomicity is covered by integration tests.
const mockGetAllowance = vi.fn();
const mockReserveRun = vi.fn();
const mockReservePoints = vi.fn();
const mockSettleUnit = vi.fn();
const mockSettlePoints = vi.fn();
vi.mock("@/lib/billing/allowance", () => ({
  getOptimizationAllowance: mockGetAllowance,
  reserveOptimizationRun: mockReserveRun,
  reserveOptimizationPoints: mockReservePoints,
  settleOptimizationRunUnit: mockSettleUnit,
  settleOptimizationRunPoints: mockSettlePoints,
}));

const mockListOrgMembers = vi.fn();
const mockGetOrgName = vi.fn();
vi.mock("@/lib/auth/members", () => ({
  listOrgMembers: mockListOrgMembers,
  getOrgName: mockGetOrgName,
}));
const mockSendEmail = vi.fn();
vi.mock("@/lib/email/send", () => ({ sendEmail: mockSendEmail }));

const mockSeatCap = vi.fn();
vi.mock("@/lib/billing/seats", async (importOriginal) => ({
  // seatCapError is pure — keep the real one so the test pins the real copy.
  ...(await importOriginal<typeof import("@/lib/billing/seats")>()),
  getSeatCapState: mockSeatCap,
}));

// Key-gate seam — mocked so the managed gates don't hit the mocked DB builder.
// Defaults: BYO + not payment-blocked, so the managed-spend path is a no-op and
// the existing flows pass straight through (managed paths covered separately).
const mockResolveKeyMode = vi.fn();
const mockManagedPaymentBlocked = vi.fn();
vi.mock("@/lib/llm/key-gate", () => ({
  resolveKeyModeForEstimate: mockResolveKeyMode,
  managedRunBlockedForPayment: mockManagedPaymentBlocked,
  KEY_MODE: { byo: "byo", managed: "managed", blocked: "blocked" },
}));

// Managed Spend Cap seam (#185/#291). Mocked so the pre-run gate's reserve is observable
// without a real ledger; estimateManagedSpendUsd stays REAL so the test pins the actual
// estimate math (including the new target-model term). Idle on the default BYO key mode.
const mockGetEffectiveManagedCap = vi.fn();
const mockReserveManagedSpend = vi.fn();
const mockNotifyManagedCapReached = vi.fn();
vi.mock("@/lib/billing/managed-spend", () => ({
  getEffectiveManagedCap: mockGetEffectiveManagedCap,
  reserveManagedSpend: mockReserveManagedSpend,
  notifyManagedCapReached: mockNotifyManagedCapReached,
}));

const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  in: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Fixtures ---

const RUBRIC_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    rubricId: RUBRIC_ID,
    instances: [{ userInput: "How do I reset my password?", expectedOutput: null, retrievalContext: null }],
    budgetRollouts: 20,
    maxIters: 10,
    ...overrides,
  };
}

// rubric found (2 criteria → per-rollout cost 10 + 5×2 = 20 Eval Points), then
// connection (agent, with ≥1 Module) found.
function resolveOwnershipChecks() {
  builder.maybeSingle
    .mockResolvedValueOnce({
      data: { id: "rubric_1", criteria: [{ name: "a" }, { name: "b" }] },
      error: null,
    })
    .mockResolvedValueOnce({
      data: { id: "conn_1", kind: "agent", optimizable_prompts: [{ name: "system", seed: "s" }] },
      error: null,
    });
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ["from", "select", "insert", "upsert", "update", "delete", "eq", "is", "in", "order", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  mockGetAuthContext.mockResolvedValue({
    userId: "user_abc",
    orgId: "org_abc",
    email: "kevin@example.com",
    role: "admin",
    canWrite: true,
  });
  builder._result = { data: null, error: null };
  builder.maybeSingle.mockResolvedValue({ data: { id: "found" }, error: null });
  builder.single.mockResolvedValue({ data: { id: "run_1" }, error: null });
  mockGetTemporalClient.mockResolvedValue({
    workflow: { start: mockWorkflowStart, getHandle: mockGetHandle },
  });
  mockWorkflowStart.mockResolvedValue(undefined);
  mockTerminate.mockResolvedValue(undefined);
  mockSignal.mockResolvedValue(undefined);
  mockInsertConnection.mockResolvedValue({ connectionId: "new_conn_1" });
  mockGetAllowance.mockResolvedValue({
    plan: "builder",
    included: 15,
    maxBudgetRollouts: 200,
    remaining: 15,
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
  });
  mockReserveRun.mockResolvedValue({
    reserved: true,
    remaining: 14,
    periodStart: "2026-06-01T00:00:00.000Z",
    // reserveOptimizationRun echoes the resolved plan; the managed-spend estimate prices off it.
    plan: "builder",
  });
  mockReservePoints.mockResolvedValue({
    reserved: true,
    balance: 4_000,
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
    capUsd: null,
    plan: "builder",
    paymentFailing: false,
  });
  mockSettleUnit.mockResolvedValue({ error: null });
  mockSettlePoints.mockResolvedValue({ error: null });
  mockSeatCap.mockResolvedValue({ violated: false, memberCount: 1, seatLimit: null });
  mockResolveKeyMode.mockResolvedValue("byo");
  mockManagedPaymentBlocked.mockResolvedValue(false);
  mockGetEffectiveManagedCap.mockResolvedValue({ capUsd: 1000 });
  mockReserveManagedSpend.mockResolvedValue({ reserved: true });
  mockNotifyManagedCapReached.mockResolvedValue(undefined);
  mockListOrgMembers.mockResolvedValue([
    { userId: "user_abc", email: "admin@example.com", role: "admin" },
    { userId: "user_ro", email: "viewer@example.com", role: "member" },
  ]);
  mockGetOrgName.mockResolvedValue("Acme");
  mockSendEmail.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- startOptimizationRun ---

describe("startOptimizationRun", () => {
  it("returns error when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({ error: "Not authenticated" });
  });

  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "member", canWrite: false });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({
      error: "Only contributors can start optimization runs",
    });
  });

  it("returns a validation error when no instances are provided", async () => {
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput({ instances: [] }))).toEqual({
      error: "At least one input instance is required",
    });
  });

  it("returns error when the rubric is not owned by the team", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({ error: "Rubric not found" });
  });

  it("returns error when the connection is not owned by the team", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: "rubric_1" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({ error: "Connection not found" });
  });

  it("rejects a non-agent connection", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: "rubric_1" }, error: null })
      .mockResolvedValueOnce({ data: { id: "conn_1", kind: "dataset" }, error: null });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({
      error: "Optimization requires an agent connection",
    });
  });

  it("rejects an existing agent connection that declares no Modules", async () => {
    // e.g. an agent connection created via the Schedules wizard, which has no Modules editor.
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: "rubric_1" }, error: null })
      .mockResolvedValueOnce({ data: { id: "conn_1", kind: "agent", optimizable_prompts: null }, error: null });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({
      error: "This agent connection has no optimizable Modules — add at least one to optimize it.",
    });
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("rejects a second active run for the org (partial-unique 23505)", async () => {
    resolveOwnershipChecks();
    builder.single.mockResolvedValue({ data: null, error: { code: "23505" } });
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput())).toEqual({
      error: "An optimization run is already active for this team",
    });
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("freezes inputs and starts the workflow on the happy path", async () => {
    resolveOwnershipChecks();
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());

    expect(result).toEqual({ optRunId: "run_1" });
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "runOptimizationWorkflow",
      expect.objectContaining({ args: [{ optRunId: "run_1" }] })
    );
  });

  it("rolls back the run row when the workflow fails to start", async () => {
    resolveOwnershipChecks();
    mockWorkflowStart.mockRejectedValue(new Error("temporal down"));
    const { startOptimizationRun } = await import("../optimizations");

    expect(await startOptimizationRun(validInput())).toEqual({
      error: "Failed to start optimization run",
    });
    expect(builder.delete).toHaveBeenCalled();
  });

  // A valid inline agent Connection: ≥1 Module, and the template references {{prompt:system}}.
  function validNewConnection() {
    return {
      type: "agent" as const,
      name: "Inline agent",
      endpoint: "https://api.example.com/agent",
      authHeader: null,
      authValue: null,
      requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
      responsePath: "output",
      optimizablePrompts: [{ name: "system", seed: "Answer helpfully." }],
    };
  }

  it("creates an inline agent Connection and starts the workflow", async () => {
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(
      validInput({ connectionId: undefined, newConnection: validNewConnection() })
    );

    expect(result).toEqual({ optRunId: "run_1" });
    expect(mockInsertConnection).toHaveBeenCalledWith(
      "org_abc",
      "user_abc",
      expect.objectContaining({ type: "agent", name: "Inline agent" })
    );
    // The run is created against the newly-created Connection id.
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ connection_id: "new_conn_1" })
    );
    expect(mockWorkflowStart).toHaveBeenCalled();
  });

  it("rolls back the inline Connection when the run hits the active-run unique violation", async () => {
    builder.single.mockResolvedValue({ data: null, error: { code: "23505" } });
    const { startOptimizationRun } = await import("../optimizations");

    expect(
      await startOptimizationRun(
        validInput({ connectionId: undefined, newConnection: validNewConnection() })
      )
    ).toEqual({ error: "An optimization run is already active for this team" });
    // The just-created Connection is deleted so a rejected start leaves no orphan.
    expect(builder.delete).toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("rejects when neither an existing nor a new Connection is provided", async () => {
    const { startOptimizationRun } = await import("../optimizations");
    expect(await startOptimizationRun(validInput({ connectionId: undefined }))).toEqual({
      error: "Provide either an existing agent connection or a new one.",
    });
  });

  it("rejects an inline Connection whose template doesn't reference a declared Module", async () => {
    const bad = { ...validNewConnection(), requestTemplate: '{"input":"{{user_input}}"}' };
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(
      validInput({ connectionId: undefined, newConnection: bad })
    );
    expect(result).toEqual({
      error: 'Declared Module "system" must be referenced as {{prompt:system}} in the request template.',
    });
    expect(mockInsertConnection).not.toHaveBeenCalled();
  });

  it("refuses runs while the team exceeds its plan's seats (#182 fail-closed)", async () => {
    mockSeatCap.mockResolvedValue({ violated: true, memberCount: 3, seatLimit: 1 });
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect((result as { error: string }).error).toContain("3 members");
    expect(builder.insert).not.toHaveBeenCalled();
  });

  // --- Allowance gates (#181) ---

  it("gates Free Teams (0 included) before any Connection or run is created", async () => {
    mockGetAllowance.mockResolvedValue({
      plan: "free",
      included: 0,
      maxBudgetRollouts: 0,
      remaining: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect((result as { error: string }).error).toContain("aren't included on the Free plan");
    expect(builder.insert).not.toHaveBeenCalled();
    expect(mockReserveRun).not.toHaveBeenCalled();
    // Free stays hard-walled (captain decision): the points-overage path is paid-only.
    expect(mockReservePoints).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled(); // gated, not exhausted — no limit email
  });

  it("rejects a budget above the plan ceiling regardless of the payload", async () => {
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput({ budgetRollouts: 201 }));
    expect((result as { error: string }).error).toContain("can't exceed 200");
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it("reserves one allowance unit (no points) for a run within the included count", async () => {
    resolveOwnershipChecks();
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    expect(mockReserveRun).toHaveBeenCalledWith("org_abc", "run_1", {
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      included: 15,
      plan: "builder",
    });
    // Within allowance: zero Eval Points (ADR-0016).
    expect(mockReservePoints).not.toHaveBeenCalled();
  });

  it("meters worst-case Eval Points past the included allowance (paid overage)", async () => {
    resolveOwnershipChecks();
    // Builder with its included runs exhausted: the run draws points, not a unit.
    mockGetAllowance.mockResolvedValue({
      plan: "builder",
      included: 15,
      maxBudgetRollouts: 200,
      remaining: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput()); // budget 20, 2 criteria
    expect(result).toEqual({ optRunId: "run_1" });
    // Worst-case = budget_rollouts(20) × per-rollout(10 + 5×2 = 20) = 400 points.
    expect(mockReservePoints).toHaveBeenCalledWith("org_abc", "run_1", 400, {
      criteria_count: 2,
      budget_rollouts: 20,
      per_rollout_cost: 20,
    });
    expect(mockReserveRun).not.toHaveBeenCalled();
    expect(mockWorkflowStart).toHaveBeenCalled();
  });

  it("refuses an overage run when the point balance is insufficient: rolls back, emails, tracks", async () => {
    resolveOwnershipChecks();
    mockGetAllowance.mockResolvedValue({
      plan: "builder",
      included: 15,
      maxBudgetRollouts: 200,
      remaining: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    mockReservePoints.mockResolvedValue({
      reserved: false,
      balance: 100,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: null,
      plan: "builder",
      paymentFailing: false,
    });
    builder._result = { data: [{ org_id: "org_abc" }], error: null }; // throttle claim wins
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect((result as { error: string }).error).toContain("Eval Points");
    expect(builder.delete).toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        // Characterization (#386): matches the pre-refactor inline
        // "optimization_runs_limit" copy byte-for-byte.
        subject: "Acme has used its Optimization Runs for this period",
        html: expect.stringContaining("15"),
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.optimization_limit_hit",
        props: { team_id: "org_abc", included: 15, cap_usd: null },
      }),
      { userId: "user_abc" }
    );
  });

  it("refuses a run when a concurrent request took the last included unit: rolls back, emails the same optimization_runs_limit copy", async () => {
    resolveOwnershipChecks();
    mockReserveRun.mockResolvedValue({
      reserved: false,
      remaining: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
      plan: "builder",
    });
    builder._result = { data: [{ org_id: "org_abc" }], error: null }; // throttle claim wins
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect((result as { error: string }).error).toContain("included this period");
    expect(mockReservePoints).not.toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Acme has used its Optimization Runs for this period",
        html: expect.stringContaining("15"),
      })
    );
  });

  it("skips the limit email when another refusal already claimed the period", async () => {
    resolveOwnershipChecks();
    mockGetAllowance.mockResolvedValue({
      plan: "builder",
      included: 15,
      maxBudgetRollouts: 200,
      remaining: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });
    mockReservePoints.mockResolvedValue({
      reserved: false,
      balance: 100,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      capUsd: null,
      plan: "builder",
      paymentFailing: false,
    });
    builder._result = { data: [], error: null }; // throttle already claimed
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("releases the unit before rollback when the workflow start fails", async () => {
    resolveOwnershipChecks();
    mockWorkflowStart.mockRejectedValue(new Error("temporal down"));
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect(result).toEqual({ error: "Failed to start optimization run" });
    expect(mockSettleUnit).toHaveBeenCalledWith("run_1");
    expect(builder.delete).toHaveBeenCalled();
  });

  it("fails closed and releases when the reservation check itself errors", async () => {
    resolveOwnershipChecks();
    mockReserveRun.mockRejectedValue(new Error("ledger unreachable"));
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect(result).toEqual({
      error: "Couldn't check your team's run allowance. Please try again.",
    });
    expect(mockSettleUnit).toHaveBeenCalledWith("run_1");
    expect(builder.delete).toHaveBeenCalled();
  });

  // --- Managed Agent spend gate (#291) ---

  // Sets up rubric → connection-ownership (which also carries agent_kind/target_model, the single
  // authoritative read the estimate reuses), in the order startOptimizationRun consumes them.
  function resolveManagedAgentChecks(agentKind: string, targetModel: string | null) {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: "rubric_1" }, error: null })
      .mockResolvedValueOnce({
        data: {
          id: "conn_1",
          kind: "agent",
          optimizable_prompts: [{ name: "system", seed: "s" }],
          agent_kind: agentKind,
          target_model: targetModel,
        },
        error: null,
      });
  }

  it("reserves exactly the extra target-model rollout term for a Managed Agent vs an external one (#291)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    mockResolveKeyMode.mockResolvedValue("managed"); // paid Team on the managed key
    const { startOptimizationRun } = await import("../optimizations");
    const input = () => validInput({ budgetRollouts: 20, maxIters: 10 });

    // External agent on the managed key: judge + reflection only (its inference is the
    // customer's own endpoint, not managed spend).
    resolveManagedAgentChecks("external", null);
    await startOptimizationRun(input());
    const externalEstimate = mockReserveManagedSpend.mock.calls[0][2] as number;

    // Same run shape, but a Managed Agent: the target model runs on the managed key, adding the
    // dominant per-rollout × instance term (20 × 1 here).
    resolveManagedAgentChecks("managed", TARGET_MODEL);
    await startOptimizationRun(input());
    const managedEstimate = mockReserveManagedSpend.mock.calls[1][2] as number;

    const targetTerm = estimateManagedSpendUsd("builder", ESTIMATE_JUDGE_PROVIDER, TARGET_MODEL, 20, 1)!;
    expect(targetTerm).toBeGreaterThan(0);
    // The Managed Agent reserves precisely the external estimate plus the target-model term —
    // the term is added, conditional on agent_kind === 'managed', and nothing else shifts.
    expect(managedEstimate - externalEstimate).toBeCloseTo(targetTerm, 10);
  });

  it("reserves the managed Anthropic target even when the reflect provider is BYO (#204)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    // The reflect side is a BYO OpenAI key (judge + reflection unmetered, the Team's own tokens),
    // but the Managed Agent target still runs on the managed Anthropic key — so its dominant spend
    // term MUST be reserved (else the run would burn it uncapped/unmetered).
    mockResolveKeyMode.mockImplementation(async (_orgId: string, provider: string) =>
      provider === "anthropic" ? "managed" : "byo"
    );
    const { startOptimizationRun } = await import("../optimizations");

    resolveManagedAgentChecks("managed", TARGET_MODEL);
    await startOptimizationRun(
      validInput({ reflectModel: "gpt-5", budgetRollouts: 20, maxIters: 10 })
    );

    // Exactly the target-model term is reserved — judge/reflect (BYO OpenAI) add nothing.
    const reservedEstimate = mockReserveManagedSpend.mock.calls[0][2] as number;
    const targetTerm = estimateManagedSpendUsd("builder", "anthropic", TARGET_MODEL, 20, 1)!;
    expect(targetTerm).toBeGreaterThan(0);
    expect(reservedEstimate).toBeCloseTo(targetTerm, 10);
  });

  it("blocks on a managed-payment failure for the Anthropic target even when reflect is BYO (#204)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    // BYO OpenAI reflect (its own payment is irrelevant), managed Anthropic target with a failed
    // managed-token invoice — the target-provider payment gate must block the run, not just the
    // reflect provider's.
    mockResolveKeyMode.mockImplementation(async (_orgId: string, provider: string) =>
      provider === "anthropic" ? "managed" : "byo"
    );
    mockManagedPaymentBlocked.mockImplementation(
      async (_orgId: string, provider: string) => provider === "anthropic"
    );
    const { startOptimizationRun } = await import("../optimizations");

    resolveManagedAgentChecks("managed", TARGET_MODEL);
    const result = await startOptimizationRun(validInput({ reflectModel: "gpt-5" }));

    expect(result).toEqual({
      error: expect.stringContaining("Managed runs are paused"),
    });
    expect(mockReserveManagedSpend).not.toHaveBeenCalled();
  });

  it("reserves the target-model term for an inline Managed Agent created via Paste-a-prompt (#293)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    mockResolveKeyMode.mockResolvedValue("managed"); // paid Team on the managed key
    const { startOptimizationRun } = await import("../optimizations");

    // External agent created inline: judge + reflection only, no managed target inference.
    await startOptimizationRun(
      validInput({ connectionId: undefined, newConnection: validNewConnection(), budgetRollouts: 20, maxIters: 10 })
    );
    const externalEstimate = mockReserveManagedSpend.mock.calls[0][2] as number;

    // Same run, but the inline "Paste a prompt" Managed Agent: targetModel comes from the
    // newConnection payload (not a Connection ownership read), and it adds the target-model term.
    await startOptimizationRun(
      validInput({
        connectionId: undefined,
        newConnection: { type: "managed_agent" as const, targetModel: TARGET_MODEL, prompt: "Be helpful." },
        budgetRollouts: 20,
        maxIters: 10,
      })
    );
    const managedEstimate = mockReserveManagedSpend.mock.calls[1][2] as number;

    const targetTerm = estimateManagedSpendUsd("builder", ESTIMATE_JUDGE_PROVIDER, TARGET_MODEL, 20, 1)!;
    expect(targetTerm).toBeGreaterThan(0);
    expect(managedEstimate - externalEstimate).toBeCloseTo(targetTerm, 10);
  });

  // --- Simple Mode dispatch + gate (#316, ADR-0015) ---

  it("dispatches a Managed Agent simple run to runSimpleOptimizationWorkflow", async () => {
    resolveManagedAgentChecks("managed", "claude-haiku-4-5-20251001");
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput({ mode: "simple" }));

    expect(result).toEqual({ optRunId: "run_1" });
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "runSimpleOptimizationWorkflow",
      expect.objectContaining({ args: [{ optRunId: "run_1" }] })
    );
  });

  it("persists mode 'simple' and defaults the generation model to Haiku", async () => {
    resolveManagedAgentChecks("managed", "claude-haiku-4-5-20251001");
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput({ mode: "simple" }));

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "simple", reflect_model: "claude-haiku-4-5-20251001" })
    );
  });

  it("honors an explicit generation-model override on a simple run", async () => {
    resolveManagedAgentChecks("managed", "claude-haiku-4-5-20251001");
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput({ mode: "simple", reflectModel: "claude-sonnet-4-6" }));

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "simple", reflect_model: "claude-sonnet-4-6" })
    );
  });

  it("rejects simple mode for an external agent (managed-only gate)", async () => {
    resolveManagedAgentChecks("external", null);
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput({ mode: "simple" }));

    expect(result).toEqual({
      error: "Simple mode is only available for a paste-a-prompt Managed Agent.",
    });
    expect(builder.insert).not.toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("rolls back an inline external agent created for a rejected simple run", async () => {
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(
      validInput({ connectionId: undefined, newConnection: validNewConnection(), mode: "simple" })
    );

    expect(result).toEqual({
      error: "Simple mode is only available for a paste-a-prompt Managed Agent.",
    });
    // The just-created external Connection is deleted so a rejected start leaves no orphan.
    expect(builder.delete).toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("still dispatches GEPA (reflective) by default for an external agent", async () => {
    resolveOwnershipChecks();
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput()); // no mode -> defaults to reflective

    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ mode: "reflective" }));
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "runOptimizationWorkflow",
      expect.anything()
    );
  });
});

// --- cancelOptimizationRun ---

describe("cancelOptimizationRun", () => {
  it("rejects a non-contributor", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "u",
      orgId: "o",
      email: "m@example.com",
      role: "member",
      canWrite: false,
    });
    const { cancelOptimizationRun } = await import("../optimizations");
    expect(await cancelOptimizationRun("run_1")).toEqual({
      error: "Only contributors can cancel optimization runs",
    });
  });

  it("returns not found when the run isn't in the caller's org", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { cancelOptimizationRun } = await import("../optimizations");
    expect(await cancelOptimizationRun("run_1")).toEqual({ error: "Optimization run not found" });
  });

  it("rejects cancelling a run that has already finished", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "completed", workflow_id: "opt-run_1" },
      error: null,
    });
    const { cancelOptimizationRun } = await import("../optimizations");
    expect(await cancelOptimizationRun("run_1")).toEqual({ error: "This run has already finished" });
    expect(mockTerminate).not.toHaveBeenCalled();
  });

  it("terminates the workflow and marks an active run failed with the canceller", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "running", workflow_id: "opt-run_1" },
      error: null,
    });
    // The guarded compare-and-set update returns the transitioned row(s).
    builder._result = { data: [{ id: "run_1" }], error: null };
    const { cancelOptimizationRun } = await import("../optimizations");
    const result = await cancelOptimizationRun("run_1");

    expect(result).toEqual({ ok: true });
    expect(mockGetHandle).toHaveBeenCalledWith("opt-run_1");
    expect(mockTerminate).toHaveBeenCalledWith("Cancelled by kevin@example.com");
    expect(builder.update).toHaveBeenCalledWith({
      status: "failed",
      error_message: "Cancelled by kevin@example.com",
      // A cancelled run is no longer waiting on anything (#102).
      paused_reason: null,
    });
    // Compare-and-set: only transition a still-active run (no clobbering a terminal status).
    // 'paused' is active too (#102): a paused run holds the slot and stays cancellable.
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running", "paused"]);
    // Cancel does NOT settle directly: terminate() is abrupt and in-flight
    // activities may still commit rollouts — the reaper's settlement sweep
    // settles the failed run after writes quiesce (#181 review).
    expect(mockSettleUnit).not.toHaveBeenCalled();
    // A user cancel is the only terminal log a cancelled run gets — the worker
    // never runs completeRun/failRun for an abruptly-terminated workflow.
    expect(mockLogInfo).toHaveBeenCalledWith("optimization run cancelled", {
      event: "optimization_run.cancelled",
      opt_run_id: "run_1",
      org_id: "org_abc",
    });
  });

  it("still marks the run failed when the workflow is already gone", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "running", workflow_id: "opt-run_1" },
      error: null,
    });
    builder._result = { data: [{ id: "run_1" }], error: null };
    mockTerminate.mockRejectedValue(new Error("workflow not found"));
    const { cancelOptimizationRun } = await import("../optimizations");

    expect(await cancelOptimizationRun("run_1")).toEqual({ ok: true });
    // The terminate failure is swallowed so the org's active slot still frees.
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("reports already-finished when the run completes between the read and the write (race)", async () => {
    // Read sees it active, but the guarded update transitions no row (workflow completed first).
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "running", workflow_id: "opt-run_1" },
      error: null,
    });
    builder._result = { data: [], error: null };
    const { cancelOptimizationRun } = await import("../optimizations");

    expect(await cancelOptimizationRun("run_1")).toEqual({ error: "This run has already finished" });
  });
});

// --- retryOptimizationRun ---

describe("retryOptimizationRun", () => {
  it("rejects a non-contributor", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "u",
      orgId: "o",
      email: "m@example.com",
      role: "member",
      canWrite: false,
    });
    const { retryOptimizationRun } = await import("../optimizations");
    expect(await retryOptimizationRun("run_1")).toEqual({
      error: "Only contributors can retry optimization runs",
    });
  });

  it("returns not found when the run isn't in the caller's org", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { retryOptimizationRun } = await import("../optimizations");
    expect(await retryOptimizationRun("run_1")).toEqual({ error: "Optimization run not found" });
    expect(mockSignal).not.toHaveBeenCalled();
  });

  it("rejects a run that isn't paused", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "running", workflow_id: "opt-run_1" },
      error: null,
    });
    const { retryOptimizationRun } = await import("../optimizations");
    expect(await retryOptimizationRun("run_1")).toEqual({ error: "This run isn't paused" });
    expect(mockSignal).not.toHaveBeenCalled();
  });

  it("rejects a paused run with no workflow to resume", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "paused", workflow_id: null },
      error: null,
    });
    const { retryOptimizationRun } = await import("../optimizations");
    expect(await retryOptimizationRun("run_1")).toEqual({
      error: "This run has no workflow to resume",
    });
  });

  it("signals the live workflow's retry-now handler on the happy path", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "paused", workflow_id: "opt-run_1" },
      error: null,
    });
    const { retryOptimizationRun } = await import("../optimizations");

    expect(await retryOptimizationRun("run_1")).toEqual({ ok: true });
    expect(mockGetHandle).toHaveBeenCalledWith("opt-run_1");
    // The signal name is the client↔worker contract (OPTIMIZATION_RETRY_NOW_SIGNAL).
    expect(mockSignal).toHaveBeenCalledWith("retryNow");
    // The action signals only — the run flips back to 'running' when the workflow's resume
    // Activity lands, never from this request.
    expect(builder.update).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith("optimization run retried", {
      event: "optimization_run.retried",
      opt_run_id: "run_1",
      org_id: "org_abc",
    });
  });

  it("surfaces a friendly error when the signal fails", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "run_1", status: "paused", workflow_id: "opt-run_1" },
      error: null,
    });
    mockSignal.mockRejectedValue(new Error("workflow not found"));
    const { retryOptimizationRun } = await import("../optimizations");

    expect(await retryOptimizationRun("run_1")).toEqual({ error: "Failed to retry the run" });
    // The signal-failure log joins the file's structured-event taxonomy with a
    // queryable event name + opt_run_id correlation (previously bare).
    expect(mockLogError).toHaveBeenCalledWith("Failed to signal optimization workflow", {
      event: "optimization_run.retry_signal_failed",
      opt_run_id: "run_1",
      workflow_id: "opt-run_1",
      error: expect.any(Error),
    });
  });
});

// --- listOptimizationRuns ---

describe("listOptimizationRuns", () => {
  it("returns an empty list when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { listOptimizationRuns } = await import("../optimizations");
    expect(await listOptimizationRuns()).toEqual([]);
  });

  it("scopes the query to the caller's org and maps nested names", async () => {
    builder._result = {
      data: [
        {
          id: "run_1",
          status: "completed",
          best_score: 0.81,
          created_at: "2026-06-01T00:00:00Z",
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
      ],
      error: null,
    };
    const { listOptimizationRuns } = await import("../optimizations");
    const rows = await listOptimizationRuns();

    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false });
    // The polled, ever-growing run list is bounded to a newest-first display window.
    expect(builder.limit).toHaveBeenCalledWith(100);
    expect(rows).toEqual([
      {
        id: "run_1",
        status: "completed",
        best_score: 0.81,
        // No seed Candidate/rollouts resolve from the shared mock fixture, so the lift baseline
        // is simply absent — the row still lists.
        seed_score: null,
        created_at: "2026-06-01T00:00:00Z",
        connection_name: "Support Agent",
        rubric_name: "Helpfulness",
      },
    ]);
  });

  it("resolves nested relations returned as single-element arrays", async () => {
    builder._result = {
      data: [
        {
          id: "run_2",
          status: "running",
          best_score: null,
          created_at: "2026-06-02T00:00:00Z",
          connections: [{ name: "Billing Agent" }],
          rubrics: [{ name: "Accuracy" }],
        },
      ],
      error: null,
    };
    const { listOptimizationRuns } = await import("../optimizations");
    const [row] = await listOptimizationRuns();
    expect(row.connection_name).toBe("Billing Agent");
    expect(row.rubric_name).toBe("Accuracy");
  });
});

// --- getOptimizationRun ---

describe("getOptimizationRun", () => {
  it("returns null when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getOptimizationRun } = await import("../optimizations");
    expect(await getOptimizationRun("opt_1")).toBeNull();
  });

  it("returns seed/winning prompt maps and the recomputed seed score", async () => {
    // maybeSingle is hit three times in order: run row, seed Candidate, winning Candidate.
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_1",
          status: "completed",
          best_candidate_id: "cand_win",
          best_score: 0.81,
          budget_rollouts: 20,
          max_iters: 10,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness", criteria: [{ name: "accuracy", weight: 1, steps: [] }] },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null })
      .mockResolvedValueOnce({ data: { prompts: { main: "optimized text" } }, error: null });

    // The seed's Pareto rollouts and their results both resolve from the shared thenable; give
    // it a shape that satisfies the rollout-id read and the criterion/score read at once.
    builder._result = { data: [{ id: "ro_1", criterion_name: "accuracy", score: 1 }], error: null };

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_1");

    expect(detail?.seedPrompts).toEqual({ main: "seed text" });
    expect(detail?.winningPrompts).toEqual({ main: "optimized text" });
    // accuracy weight 1, single rollout score 1 → seed overall 1.0
    expect(detail?.seedScore).toBeCloseTo(1);
  });

  it("reads the seed's full-set rollouts across BOTH phases so Simple runs show a lift (#316)", async () => {
    // Simple Mode scores the seed as phase 'full', GEPA as 'pareto'. The seed-score reader must
    // match either, or a completed Simple run shows best_score with no baseline/lift. The mock
    // builder is phase-agnostic, so we assert the query is constructed for both phases.
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_simple",
          status: "completed",
          best_candidate_id: "cand_win",
          best_score: 0.9,
          budget_rollouts: 20,
          max_iters: 10,
          connections: { name: "JSON Formatter" },
          rubrics: { name: "Valid JSON", criteria: [{ name: "valid", weight: 1, steps: [] }] },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed" } }, error: null })
      .mockResolvedValueOnce({ data: { prompts: { main: "optimized" } }, error: null });
    builder._result = { data: [{ id: "ro_1", criterion_name: "valid", score: 0.5 }], error: null };

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_simple");

    // The seed baseline resolves (not null) — the lift renders for a Simple run.
    expect(detail?.seedScore).toBeCloseTo(0.5);
    // And the phase filter matches the full-set phases, not just 'pareto'.
    expect(builder.in).toHaveBeenCalledWith("phase", ["pareto", "full"]);
  });

  it("returns derived progress counts (candidates discovered, rollouts spent)", async () => {
    // run row, then seed Candidate. No best_candidate_id → no winner read.
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_3",
          status: "running",
          best_candidate_id: null,
          best_score: null,
          budget_rollouts: 50,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness", criteria: [] },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null });

    // Both progress reads are head-counts (candidates, then rollouts via an inner join), so
    // each resolves the shared thenable's `count`. The active-status gate runs them because the
    // run is "running".
    builder._result = { data: null, count: 17, error: null };

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_3");

    expect(detail?.candidateCount).toBe(17);
    expect(detail?.rolloutsSpent).toBe(17);
    // Empty criteria → no seed baseline recomputed (mirrors the detail path).
    expect(detail?.seedScore).toBeNull();
  });

  it("leaves winning prompts null when the run has no best Candidate yet", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_2",
          status: "running",
          best_candidate_id: null,
          best_score: null,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness", criteria: [{ name: "accuracy", weight: 1, steps: [] }] },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null });
    builder._result = { data: [], error: null };

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_2");

    expect(detail?.winningPrompts).toBeNull();
    expect(detail?.seedScore).toBeNull(); // no Pareto rollouts → no baseline
  });
});
