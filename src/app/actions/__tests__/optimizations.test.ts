import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
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
  rpc: Mock;
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
const mockSnapshotDatasetInstances = vi.fn();
const mockResolveEvalRunInstances = vi.fn();

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
vi.mock("@/lib/optimization/dataset-snapshot", () => ({
  snapshotDatasetInstances: mockSnapshotDatasetInstances,
}));
vi.mock("@/lib/optimization/eval-run-instances", () => ({
  resolveEvalRunInstances: mockResolveEvalRunInstances,
}));

// Allowance seams (#181) — the pre-check (`getOptimizationAllowance`) and the two settle RPCs
// stay called DIRECTLY by the action (the Free hard-stop and the rollback callback aren't part
// of the Run Gate port, #382). `reserveOptimizationRun`/`reserveOptimizationPoints` moved INSIDE
// the gate (`run-gate.ts`) and are exercised there, not here — see run-gate.test.ts.
const mockGetAllowance = vi.fn();
const mockSettleUnit = vi.fn();
const mockSettlePoints = vi.fn();
vi.mock("@/lib/billing/allowance", () => ({
  getOptimizationAllowance: mockGetAllowance,
  settleOptimizationRunUnit: mockSettleUnit,
  settleOptimizationRunPoints: mockSettlePoints,
}));

// Run Gate (#377/#382) — startOptimizationRun delegates its whole billing pipeline (seat cap,
// managed-payment, allowance-unit/Eval-Point dual-meter reserve, Managed Spend Cap reserve,
// notifications, rollback) to this seam. Its own refusal matrix, message precedence, and the
// dual-meter branch are unit-tested directly in run-gate.test.ts; this file only covers
// startOptimizationRun's WIRING — the requests it builds (including the managed-spend terms for
// the judge/reflect/Managed-Agent-target legs), and how it reacts to an ok / refusal result
// (including invoking the callbacks it hands the gate).
const mockCheckRunPreflight = vi.fn();
const mockReserveRunOrRefuse = vi.fn();
vi.mock("@/lib/billing/run-gate", () => ({
  checkRunPreflight: mockCheckRunPreflight,
  reserveRunOrRefuse: mockReserveRunOrRefuse,
  // The action localizes refusals at the request boundary; outside a request
  // (this node test) the helper falls back to the en-rendered `error`.
  localizeRunGateError: vi.fn(async (refusal: { error: string }) => refusal.error),
  RUN_KIND: { eval: "eval", optimization: "optimization" },
  KEY_MODE_STRATEGY: { perProvider: "per_provider", judgeAnyByo: "judge_any_byo" },
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
  rpc: vi.fn(),
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Fixtures ---

const RUBRIC_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

const DATASET_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const EVAL_RUN_ID = "55555555-5555-4555-8555-555555555555";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    rubricId: RUBRIC_ID,
    instancesSource: {
      type: "inline" as const,
      instances: [{ userInput: "How do I reset my password?", expectedOutput: null, retrievalContext: null }],
    },
    budgetRollouts: 20,
    maxIters: 10,
    ...overrides,
  };
}

// Same as validInput, but sourced from a dataset-Connection snapshot (#82) rather than inline
// rows — connectionId/newConnection (the agent System) are untouched; only instancesSource
// changes.
function validDatasetInput(overrides: Record<string, unknown> = {}) {
  return validInput({
    instancesSource: {
      type: "dataset_snapshot" as const,
      connectionId: DATASET_CONNECTION_ID,
      windowMinutes: 1440,
    },
    ...overrides,
  });
}

// Same as validInput, but sourced from an existing Eval Run's rows (#83).
function validEvalRunInput(overrides: Record<string, unknown> = {}) {
  return validInput({
    instancesSource: {
      type: "eval_run" as const,
      evalRunId: EVAL_RUN_ID,
    },
    ...overrides,
  });
}

// Queues the dataset Connection row `startOptimizationRun` reads before anything else — the
// FIRST maybeSingle() call when instancesSource.type is 'dataset_snapshot'. Call
// resolveOwnershipChecks() afterward (queues rubric, then agent connection) for a happy-path
// dataset test that runs all the way through.
function mockDatasetConnectionRow(overrides: Record<string, unknown> = {}) {
  builder.maybeSingle.mockResolvedValueOnce({
    data: {
      id: DATASET_CONNECTION_ID,
      kind: "dataset",
      provider: "custom",
      endpoint: "https://api.example.com/logs",
      auth_header: "Authorization",
      auth_secret_id: null,
      request_template: { limit: "{{max_rows}}" },
      response_path: "data",
      config: { field_map: { user_input: "prompt", agent_output: "completion" } },
      ...overrides,
    },
    error: null,
  });
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
  builder.rpc.mockResolvedValue({ data: null, error: null });
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
  mockSettleUnit.mockResolvedValue({ error: null });
  mockSettlePoints.mockResolvedValue({ error: null });
  mockCheckRunPreflight.mockResolvedValue({ ok: true });
  mockReserveRunOrRefuse.mockResolvedValue({
    ok: true,
    plan: "builder",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
  });
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
    expect(
      await startOptimizationRun(
        validInput({ instancesSource: { type: "inline" as const, instances: [] } })
      )
    ).toEqual({
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

  // --- Instances source: dataset-Connection snapshot (#82) ---
  //
  // The snapshot is resolved BEFORE the run row exists and before any Run Gate call, so these
  // tests focus on that resolution: the org-scoped Connection lookup + credential decrypt, the
  // snapshotDatasetInstances wiring, and that a fetch failure or an empty window refuses with
  // nothing created. The row cap / mapping / SSRF inheritance themselves are unit-tested
  // directly in dataset-snapshot.test.ts — this file only covers the ACTION's wiring into it.

  describe("dataset-Connection snapshot source", () => {
    it("snapshots the dataset Connection's rows and freezes them before the run row exists", async () => {
      mockDatasetConnectionRow();
      resolveOwnershipChecks();
      mockSnapshotDatasetInstances.mockResolvedValue({
        instances: [{ userInput: "Q1", expectedOutput: null, retrievalContext: null }],
      });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validDatasetInput());

      expect(result).toEqual({ optRunId: "run_1" });
      expect(mockSnapshotDatasetInstances).toHaveBeenCalledWith(
        expect.objectContaining({ id: DATASET_CONNECTION_ID, provider: "custom" }),
        null,
        1440
      );
      expect(builder.insert).toHaveBeenCalledWith([
        expect.objectContaining({ user_input: "Q1", instance_index: 0 }),
      ]);
      expect(mockWorkflowStart).toHaveBeenCalled();
    });

    it("decrypts the Connection's credential before the fetch when one is set", async () => {
      mockDatasetConnectionRow({ auth_secret_id: "secret-1", provider: "posthog" });
      resolveOwnershipChecks();
      builder.rpc.mockResolvedValue({ data: "Bearer decrypted-key", error: null });
      mockSnapshotDatasetInstances.mockResolvedValue({
        instances: [{ userInput: "Q", expectedOutput: null, retrievalContext: null }],
      });
      const { startOptimizationRun } = await import("../optimizations");
      await startOptimizationRun(validDatasetInput());

      expect(builder.rpc).toHaveBeenCalledWith("get_connection_auth", { p_secret_id: "secret-1" });
      expect(mockSnapshotDatasetInstances).toHaveBeenCalledWith(
        expect.anything(),
        "Bearer decrypted-key",
        1440
      );
    });

    it("refuses cleanly with no run row or reservation when the window has no rows", async () => {
      mockDatasetConnectionRow();
      mockSnapshotDatasetInstances.mockResolvedValue({ instances: [] });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validDatasetInput());

      expect(result).toEqual({
        error: "That Connection had no rows in the selected window — pick a wider window or another source.",
      });
      expect(builder.insert).not.toHaveBeenCalled();
      expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("refuses when the chosen connection isn't a dataset Connection", async () => {
      builder.maybeSingle.mockResolvedValueOnce({
        data: { id: DATASET_CONNECTION_ID, kind: "agent" },
        error: null,
      });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validDatasetInput());
      expect(result).toEqual({ error: "Select a dataset connection to snapshot instances from" });
      expect(mockSnapshotDatasetInstances).not.toHaveBeenCalled();
    });

    it("refuses when the dataset connection isn't found (e.g. a cross-team id)", async () => {
      builder.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validDatasetInput());
      expect(result).toEqual({ error: "Dataset connection not found" });
    });

    it("surfaces a fetch failure without creating a run row, logging an SSRF refusal distinctly", async () => {
      mockDatasetConnectionRow();
      mockSnapshotDatasetInstances.mockResolvedValue({ error: "endpoint", detail: "blocked" });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validDatasetInput());

      expect(result).toEqual({ error: "Couldn't fetch rows from that Connection. Please try again." });
      expect(builder.insert).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledWith(
        "dataset instance snapshot blocked or unreachable",
        expect.objectContaining({ error_code: "endpoint" })
      );
    });

    it("prices the judge volume as the rollout budget alone, independent of instance count", async () => {
      mockDatasetConnectionRow();
      resolveOwnershipChecks();
      mockSnapshotDatasetInstances.mockResolvedValue({
        instances: [
          { userInput: "Q1", expectedOutput: null, retrievalContext: null },
          { userInput: "Q2", expectedOutput: null, retrievalContext: null },
        ],
      });
      const { startOptimizationRun } = await import("../optimizations");
      await startOptimizationRun(validDatasetInput());

      // budget_rollouts is denominated in instance-invocations, so the judge
      // volume is the budget itself — multiplying by instance count inflated
      // the reserve by the dataset size (the opt-4afa3642 prod incident).
      expect(mockReserveRunOrRefuse).toHaveBeenCalledWith(
        expect.objectContaining({
          managedSpendTerms: expect.arrayContaining([
            expect.objectContaining({ volume: 20 }), // budgetRollouts(20), NOT ×instances
          ]),
        })
      );
    });
  });

  // --- Instances source: seed from an existing Eval Run (#83) ---
  //
  // The Eval Run's rows are resolved BEFORE the run row exists and before any Run Gate call,
  // mirroring the dataset-Connection snapshot source above. These tests focus on that
  // resolution: the org-scoped read (a foreign/unknown eval_run_id refuses cleanly, the
  // cross-tenant leak class the tenant lint guard exists for) and that a zero-row source
  // refuses with nothing created. The copy/cap/agent_output-exclusion mapping itself is
  // unit-tested directly in eval-run-instances.test.ts — this file only covers the ACTION's
  // wiring into it.

  describe("Eval Run instances source (#83)", () => {
    it("seeds instances from the Eval Run's rows and freezes them before the run row exists", async () => {
      resolveOwnershipChecks();
      mockResolveEvalRunInstances.mockResolvedValue({
        instances: [{ userInput: "Q1", expectedOutput: null, retrievalContext: null }],
      });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validEvalRunInput());

      expect(result).toEqual({ optRunId: "run_1" });
      expect(mockResolveEvalRunInstances).toHaveBeenCalledWith("org_abc", EVAL_RUN_ID);
      expect(builder.insert).toHaveBeenCalledWith([
        expect.objectContaining({ user_input: "Q1", instance_index: 0 }),
      ]);
      expect(mockWorkflowStart).toHaveBeenCalled();
    });

    it("refuses cleanly with no run row or reservation for a foreign or unknown eval_run_id", async () => {
      mockResolveEvalRunInstances.mockResolvedValue({ error: "not_found" });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validEvalRunInput());

      expect(result).toEqual({ error: "Eval run not found" });
      expect(builder.insert).not.toHaveBeenCalled();
      expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("refuses cleanly with specific copy when the Eval Run has no rows", async () => {
      mockResolveEvalRunInstances.mockResolvedValue({ error: "empty" });
      const { startOptimizationRun } = await import("../optimizations");
      const result = await startOptimizationRun(validEvalRunInput());

      expect(result).toEqual({
        error: "That eval run has no rows to seed instances from — pick another eval run.",
      });
      expect(builder.insert).not.toHaveBeenCalled();
      expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("prices the judge volume as the rollout budget alone, independent of instance count", async () => {
      resolveOwnershipChecks();
      mockResolveEvalRunInstances.mockResolvedValue({
        instances: [
          { userInput: "Q1", expectedOutput: null, retrievalContext: null },
          { userInput: "Q2", expectedOutput: null, retrievalContext: null },
        ],
      });
      const { startOptimizationRun } = await import("../optimizations");
      await startOptimizationRun(validEvalRunInput());

      expect(mockReserveRunOrRefuse).toHaveBeenCalledWith(
        expect.objectContaining({
          managedSpendTerms: expect.arrayContaining([
            expect.objectContaining({ volume: 20 }), // budgetRollouts(20), NOT ×instances
          ]),
        })
      );
    });
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

  // --- Run Gate wiring (#377/#382) ---
  //
  // The gate's own refusal matrix (seat cap, missing key, payment-failing, allowance
  // exhausted, points exhausted, managed cap exceeded) and message precedence are unit-tested
  // directly in run-gate.test.ts. These tests cover startOptimizationRun's WIRING into the
  // gate: the two checkRunPreflight calls run at the right points with the right args, the
  // reserve request carries the right dual-meter spec and managed-spend terms, and a refusal
  // from either phase short-circuits with its error.

  it("checks the seat-cap preflight before the allowance/rubric/Connection work, and never reserves on refusal", async () => {
    mockCheckRunPreflight.mockResolvedValueOnce({
      ok: false,
      refusal: { kind: "seat_cap", error: "Your team has 3 members but the current plan includes 1" },
    });
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect((result as { error: string }).error).toContain("3 members");
    expect(mockGetAllowance).not.toHaveBeenCalled();
    expect(builder.insert).not.toHaveBeenCalled();
    expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
  });

  it("calls the seat-cap preflight for optimization with no key/payment requirements", async () => {
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    expect(mockCheckRunPreflight).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runKind: "optimization",
        orgId: "org_abc",
        requireProviderKeyForFreePlan: false,
        managedPaymentCheckProviders: [],
      })
    );
  });

  it("calls the managed-payment preflight with the run's provider(s) once the Connection resolves", async () => {
    resolveOwnershipChecks();
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    // Default reflect model is Anthropic; no Managed Agent target on this external connection.
    expect(mockCheckRunPreflight).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runKind: "optimization",
        requireProviderKeyForFreePlan: false,
        managedPaymentCheckProviders: [ESTIMATE_JUDGE_PROVIDER],
      })
    );
  });

  it("refuses on a managed-payment failure surfaced by the gate, rolling back an inline Connection", async () => {
    mockCheckRunPreflight.mockImplementation(async (req: { managedPaymentCheckProviders: string[] }) =>
      req.managedPaymentCheckProviders.length > 0
        ? {
            ok: false,
            refusal: { kind: "managed_payment_failing", error: "Managed runs are paused: a managed-token payment failed." },
          }
        : { ok: true }
    );
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(
      validInput({ connectionId: undefined, newConnection: validNewConnection() })
    );
    expect(result).toEqual({ error: expect.stringContaining("Managed runs are paused") });
    expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
    // The just-created Connection is rolled back — a refused start leaves no orphan.
    expect(builder.delete).toHaveBeenCalled();
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
    // Free stays hard-walled (captain decision): the points-overage path is paid-only.
    expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
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
    expect(mockReserveRunOrRefuse).toHaveBeenCalledWith(
      expect.objectContaining({
        runKind: "optimization",
        orgId: "org_abc",
        userId: "user_abc",
        runId: "run_1",
        pointReserve: {
          kind: "optimization_unit",
          period: {
            periodStart: "2026-06-01T00:00:00.000Z",
            periodEnd: "2026-07-01T00:00:00.000Z",
            included: 15,
            plan: "builder",
          },
        },
        managedSpendRef: { optRunId: "run_1" },
      })
    );
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
    expect(mockReserveRunOrRefuse).toHaveBeenCalledWith(
      expect.objectContaining({
        pointReserve: {
          kind: "optimization_points",
          pointCost: 400,
          included: 15,
          metadata: { criteria_count: 2, budget_rollouts: 20, per_rollout_cost: 20 },
        },
      })
    );
    expect(mockWorkflowStart).toHaveBeenCalled();
  });

  it("returns the gate's refusal and never starts the workflow", async () => {
    resolveOwnershipChecks();
    mockReserveRunOrRefuse.mockResolvedValue({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error: "Your team has used its 15 included Optimization Runs, and this run's 400 Eval Points exceed your remaining balance. Add Eval Points or set an Overage Cap in Billing.",
      },
    });
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect(result).toEqual({
      error: "Your team has used its 15 included Optimization Runs, and this run's 400 Eval Points exceed your remaining balance. Add Eval Points or set an Overage Cap in Billing.",
    });
    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalled(); // the run row IS created before the reserve call
  });

  it("wires the deleteRun callback to a direct row delete (nothing reserved yet)", async () => {
    resolveOwnershipChecks();
    mockReserveRunOrRefuse.mockImplementation(async (req: { callbacks: { deleteRun: () => Promise<void> } }) => {
      await req.callbacks.deleteRun();
      return { ok: false, refusal: { kind: "optimization_allowance_exhausted", error: "no allowance left" } };
    });
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    expect(builder.delete).toHaveBeenCalled();
    // Nothing was reserved — the settle RPCs never fire.
    expect(mockSettleUnit).not.toHaveBeenCalled();
    expect(mockSettlePoints).not.toHaveBeenCalled();
  });

  it("wires the rollbackReservations callback to settle both meters, then delete the run row", async () => {
    resolveOwnershipChecks();
    mockReserveRunOrRefuse.mockImplementation(async (req: { callbacks: { rollbackReservations: () => Promise<void> } }) => {
      await req.callbacks.rollbackReservations();
      return { ok: false, refusal: { kind: "managed_cap_exceeded", error: "boom" } };
    });
    const { startOptimizationRun } = await import("../optimizations");
    const result = await startOptimizationRun(validInput());
    expect(result).toEqual({ error: "boom" });
    expect(mockSettleUnit).toHaveBeenCalledWith("run_1");
    expect(mockSettlePoints).toHaveBeenCalledWith("run_1", "skipped");
    expect(builder.delete).toHaveBeenCalled();
  });

  it("rolls back an inline Connection when the gate's rollbackReservations callback fires", async () => {
    mockReserveRunOrRefuse.mockImplementation(async (req: { callbacks: { rollbackReservations: () => Promise<void> } }) => {
      await req.callbacks.rollbackReservations();
      return { ok: false, refusal: { kind: "managed_cap_exceeded", error: "boom" } };
    });
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(
      validInput({ connectionId: undefined, newConnection: validNewConnection() })
    );
    // Both the run row and the just-created Connection are deleted.
    expect(builder.delete).toHaveBeenCalledTimes(2);
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

  // --- Managed-spend term wiring (#185, #204, #291) ---

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

  it("declares the judge + reflect managed-spend terms, and no target term, for an external agent", async () => {
    resolveOwnershipChecks();
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    const req = mockReserveRunOrRefuse.mock.calls[0][0];
    expect(req.managedSpendTerms).toEqual([
      {
        keyModeStrategy: "per_provider",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        volume: 20, // budgetRollouts(20) — instance-invocation ceiling, never ×instances
        criteriaCount: 2,
      },
      {
        keyModeStrategy: "per_provider",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        volume: 10, // maxIters (reflective mode)
        criteriaCount: 1,
      },
    ]);
  });

  it("adds a third target-model term for a Managed Agent (#291)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    resolveManagedAgentChecks("managed", TARGET_MODEL);
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput());
    const req = mockReserveRunOrRefuse.mock.calls[0][0];
    expect(req.managedSpendTerms).toHaveLength(3);
    expect(req.managedSpendTerms[2]).toEqual({
      keyModeStrategy: "per_provider",
      provider: "anthropic",
      model: TARGET_MODEL,
      volume: 20, // budgetRollouts(20) — instance-invocation ceiling, never ×instances
      criteriaCount: 1,
    });
  });

  it("uses the target's OWN provider for its managed-spend term, independent of the reflect provider (#204)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    resolveManagedAgentChecks("managed", TARGET_MODEL);
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput({ reflectModel: "gpt-5" }));
    const req = mockReserveRunOrRefuse.mock.calls[0][0];
    // Judge + reflect run on the reflect model's own provider (openai)...
    expect(req.managedSpendTerms[0].provider).toBe("openai");
    expect(req.managedSpendTerms[1].provider).toBe("openai");
    // ...but the target term is independently anthropic, regardless of the reflect side.
    expect(req.managedSpendTerms[2]).toEqual({
      keyModeStrategy: "per_provider",
      provider: "anthropic",
      model: TARGET_MODEL,
      volume: 20,
      criteriaCount: 1,
    });
  });

  it("declares both providers to the managed-payment preflight for a Managed Agent on a different reflect provider (#204)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    resolveManagedAgentChecks("managed", TARGET_MODEL);
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(validInput({ reflectModel: "gpt-5" }));
    expect(mockCheckRunPreflight).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ managedPaymentCheckProviders: ["openai", "anthropic"] })
    );
  });

  it("reserves the target-model term for an inline Managed Agent created via Paste-a-prompt (#293)", async () => {
    const TARGET_MODEL = "claude-haiku-4-5-20251001";
    const { startOptimizationRun } = await import("../optimizations");
    await startOptimizationRun(
      validInput({
        connectionId: undefined,
        newConnection: { type: "managed_agent" as const, targetModel: TARGET_MODEL, prompt: "Be helpful." },
      })
    );
    const req = mockReserveRunOrRefuse.mock.calls[0][0];
    expect(req.managedSpendTerms).toHaveLength(3);
    expect(req.managedSpendTerms[2]).toEqual({
      keyModeStrategy: "per_provider",
      provider: "anthropic",
      model: TARGET_MODEL,
      volume: 20,
      criteriaCount: 1,
    });
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
    // The just-created inline Connection is deleted so a rejected start leaves no orphan.
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

  it("scopes the query to the caller's org, maps nested names, and reads the persisted seed_score", async () => {
    builder._result = {
      data: [
        {
          id: "run_1",
          status: "completed",
          best_score: 0.81,
          // Persisted at the completion transition (#113) — the list reads it straight off the
          // row rather than recomputing it from the seed Candidate's rollout_results.
          seed_score: 0.62,
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
        seed_score: 0.62,
        created_at: "2026-06-01T00:00:00Z",
        connection_name: "Support Agent",
        rubric_name: "Helpfulness",
      },
    ]);
  });

  it("coerces a seed_score arriving as a string from PostgREST (numeric(4,3))", async () => {
    builder._result = {
      data: [
        {
          id: "run_1",
          status: "completed",
          best_score: "0.81",
          seed_score: "0.62",
          created_at: "2026-06-01T00:00:00Z",
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
      ],
      error: null,
    };
    const { listOptimizationRuns } = await import("../optimizations");
    const [row] = await listOptimizationRuns();
    expect(row.best_score).toBe(0.81);
    expect(row.seed_score).toBe(0.62);
  });

  it("claims no lift when seed_score is null (a run completed before this column existed)", async () => {
    builder._result = {
      data: [
        {
          id: "run_1",
          status: "completed",
          best_score: 0.81,
          seed_score: null,
          created_at: "2026-06-01T00:00:00Z",
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
      ],
      error: null,
    };
    const { listOptimizationRuns } = await import("../optimizations");
    const [row] = await listOptimizationRuns();
    expect(row.seed_score).toBeNull();
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

  it("returns seed/winning prompt maps and the persisted seed_score", async () => {
    // maybeSingle is hit three times in order: run row, seed Candidate, winning Candidate.
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_1",
          status: "completed",
          best_candidate_id: "cand_win",
          best_score: 0.81,
          // Persisted at the completion transition (#113) — the detail view reads it straight
          // off the row rather than recomputing it from the seed Candidate's rollout_results.
          seed_score: 0.62,
          budget_rollouts: 20,
          max_iters: 10,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null })
      .mockResolvedValueOnce({ data: { prompts: { main: "optimized text" } }, error: null });

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_1");

    expect(detail?.seedPrompts).toEqual({ main: "seed text" });
    expect(detail?.winningPrompts).toEqual({ main: "optimized text" });
    expect(detail?.seedScore).toBeCloseTo(0.62);
  });

  it("coerces a seed_score arriving as a string from PostgREST (numeric(4,3))", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_1",
          status: "completed",
          best_candidate_id: "cand_win",
          best_score: "0.81",
          seed_score: "0.62",
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null })
      .mockResolvedValueOnce({ data: { prompts: { main: "optimized text" } }, error: null });

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_1");
    expect(detail?.seedScore).toBeCloseTo(0.62);
  });

  it("claims no lift when seed_score is null (a run completed before this column existed)", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "opt_1",
          status: "completed",
          best_candidate_id: "cand_win",
          best_score: 0.81,
          seed_score: null,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null })
      .mockResolvedValueOnce({ data: { prompts: { main: "optimized text" } }, error: null });

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_1");
    expect(detail?.seedScore).toBeNull();
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
          seed_score: null,
          budget_rollouts: 50,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
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
          seed_score: null,
          connections: { name: "Support Agent" },
          rubrics: { name: "Helpfulness" },
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "cand_seed", prompts: { main: "seed text" } }, error: null });
    builder._result = { data: [], error: null };

    const { getOptimizationRun } = await import("../optimizations");
    const detail = await getOptimizationRun("opt_2");

    expect(detail?.winningPrompts).toBeNull();
    expect(detail?.seedScore).toBeNull();
  });
});
