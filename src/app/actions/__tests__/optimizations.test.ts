import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
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
const mockGetHandle = vi.fn(() => ({ terminate: mockTerminate }));
const mockGetTemporalClient = vi.fn();
const mockInsertConnection = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/temporal/client", () => ({ getTemporalClient: mockGetTemporalClient }));
vi.mock("@/lib/connections/create", () => ({ insertConnection: mockInsertConnection }));

const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
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

// rubric found, then connection (agent, with ≥1 Module) found.
function resolveOwnershipChecks() {
  builder.maybeSingle
    .mockResolvedValueOnce({ data: { id: "rubric_1" }, error: null })
    .mockResolvedValueOnce({
      data: { id: "conn_1", kind: "agent", optimizable_prompts: [{ name: "system", seed: "s" }] },
      error: null,
    });
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ["from", "select", "insert", "update", "delete", "eq", "in", "order", "limit"] as const) {
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
  mockInsertConnection.mockResolvedValue({ connectionId: "new_conn_1" });
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
    });
    // Compare-and-set: only transition a still-active run (no clobbering a terminal status).
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running"]);
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
