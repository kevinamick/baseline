import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
const mockFetch = vi.fn();
const mockWorkflowStart = vi.fn();
const mockWorkflowDescribe = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
// The Temporal client seam: createEvalRun starts the workflow by string name through it.
// Mocked so no real gRPC connection is made.
vi.mock("@/lib/temporal/client", () => ({
  getTemporalClient: async () => ({
    workflow: {
      start: mockWorkflowStart,
      getHandle: () => ({ describe: mockWorkflowDescribe }),
    },
  }),
}));

vi.stubGlobal("fetch", mockFetch);


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
  // Makes the builder thenable so chains ending in a raw method can be awaited.
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

for (const method of ["from", "select", "insert", "upsert", "update", "delete", "eq", "is", "in", "order", "limit"] as const) {
  builder[method].mockReturnValue(builder);
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: builder,
}));

// Provider-key gate (#184, ADR-0020): the key resolution itself is unit-tested in
// key-gate.test.ts; here it's a seam so createEvalRun's wiring (refuse before any row
// exists, otherwise proceed) is what's covered.
const mockBlockedForMissingKey = vi.fn();
vi.mock("@/lib/llm/key-gate", () => ({
  evalRunBlockedForMissingKey: mockBlockedForMissingKey,
  missingKeyError: () => "No provider key is available.",
}));

// --- Fixtures ---

const sampleRows = [
  { userInput: "What is 2+2?", agentOutput: "4" },
  { userInput: "Capital of France?", agentOutput: "Paris", expectedOutput: "Paris" },
];

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", role: "admin", canWrite: true });
  mockBlockedForMissingKey.mockResolvedValue(false);
  builder._result = { data: null, error: null };
  builder.single.mockResolvedValue({ data: { id: "run_1" }, error: null });
  // Default: rubric ownership check passes, run detail lookup returns nothing.
  // Tests that need different behaviour override maybeSingle individually.
  builder.maybeSingle.mockResolvedValue({ data: { id: "rubric_1" }, error: null });
  builder.rpc.mockResolvedValue({ error: null });
  mockFetch.mockResolvedValue({ ok: true });
  // Temporal is the sole eval-run path: the workflow starts cleanly by default, and a workflow
  // lookup (workflowExists, used to disambiguate an ambiguous start failure) reports "not found".
  mockWorkflowStart.mockResolvedValue({ workflowId: "eval-run_1" });
  mockWorkflowDescribe.mockRejectedValue(new Error("workflow not found"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- createEvalRun ---

describe("createEvalRun", () => {
  it("returns error when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" })).toEqual({
      error: "Not authenticated",
    });
  });

  it("returns error for empty rows array", async () => {
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", [], { inputSource: "manual" })).toEqual({
      error: "At least one input row is required",
    });
  });

  it("returns error when rubric is not owned by the authenticated user", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("other_rubric", sampleRows, { inputSource: "manual" })).toEqual({
      error: "Rubric not found",
    });
  });

  it("returns error when run insert fails", async () => {
    builder.single.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" })).toEqual({
      error: "Failed to create eval run",
    });
  });

  it("deletes the run and returns error when rows insert fails", async () => {
    // Both the rows insert and the compensating delete go through builder._result (thenable).
    // The delete error is intentionally ignored by the action, so sharing the same
    // error result for both is fine and keeps the test simple.
    builder._result = { data: null, error: { message: "constraint violation" } };
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" })).toEqual({
      error: "Failed to save input rows",
    });
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "run_1");
  });

  it("refuses with the missing-key copy before any row exists when no provider has a key (ADR-0020)", async () => {
    mockBlockedForMissingKey.mockResolvedValue(true);
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" })).toEqual({
      error: "No provider key is available.",
    });
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it("returns runId and fires analytics on success", async () => {
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, {
      inputSource: "manual",
      description: "Baseline",
      notificationEmails: ["ops@example.com"],
    });
    expect(result).toEqual({ runId: "run_1" });
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "eval_run.created",
        props: expect.objectContaining({ rubric_id: "rubric_1", row_count: 2 }),
      }),
      { userId: "user_abc" }
    );
  });

  it("inserts run with created_by from the authenticated user", async () => {
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: "user_abc", rubric_id: "rubric_1" })
    );
  });

  it("inserts rows with correct shape and zero-based index order", async () => {
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(builder.insert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ row_index: 0, user_input: "What is 2+2?", agent_output: "4" }),
        expect.objectContaining({ row_index: 1, user_input: "Capital of France?", expected_output: "Paris" }),
      ])
    );
  });

  // Temporal is the sole eval-run execution path (#123): createEvalRun starts the durable
  // workflow directly — no pgmq enqueue, no worker wake.
  it("starts the Eval Run workflow by name with the run id — no pgmq enqueue, no wake", async () => {
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });

    expect(result).toEqual({ runId: "run_1" });
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "runEvalWorkflow",
      expect.objectContaining({
        workflowId: "eval-run_1",
        args: [{ evalRunId: "run_1" }],
      })
    );
    // No pgmq involvement: neither the enqueue rpc nor the worker wake fires.
    expect(builder.rpc).not.toHaveBeenCalledWith("enqueue_eval_run", expect.anything());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stamps workflow_id on the run before starting the workflow", async () => {
    const order: string[] = [];
    builder.update.mockImplementationOnce(() => {
      order.push("stamp");
      return builder;
    });
    mockWorkflowStart.mockImplementationOnce(async () => {
      order.push("start");
      return { workflowId: "eval-run_1" };
    });

    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });

    expect(builder.update).toHaveBeenCalledWith({ workflow_id: "eval-run_1" });
    expect(order).toEqual(["stamp", "start"]);
  });

  it("rolls the run back and surfaces an error when the workflow start fails", async () => {
    mockWorkflowStart.mockRejectedValue(new Error("temporal unreachable"));
    const { createEvalRun } = await import("../eval-runs");

    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" })).toEqual({
      error: "Failed to start eval run",
    });
    // rollBackRun deletes the half-created run (nothing to release, ADR-0020).
    expect(builder.delete).toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("keeps the run when the start call errored but the workflow actually exists", async () => {
    // The start response can be lost (gRPC deadline / connection drop) after the server
    // accepted it. Rolling back then would orphan a live workflow against a missing row.
    mockWorkflowStart.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
    mockWorkflowDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
    const { createEvalRun } = await import("../eval-runs");

    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" })).toEqual({
      runId: "run_1",
    });
    expect(builder.delete).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalled();
  });
});

// --- getEvalRuns ---

describe("getEvalRuns", () => {
  it("returns empty array when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getEvalRuns } = await import("../eval-runs");
    expect(await getEvalRuns("rubric_1")).toEqual([]);
  });

  it("verifies rubric team ownership and scopes query to rubric_id", async () => {
    builder._result = { data: [], error: null };
    const { getEvalRuns } = await import("../eval-runs");
    await getEvalRuns("rubric_1");
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
    expect(builder.eq).toHaveBeenCalledWith("rubric_id", "rubric_1");
  });

  it("bounds the polled run-history read so it can't grow unbounded", async () => {
    builder._result = { data: [], error: null };
    const { getEvalRuns } = await import("../eval-runs");
    await getEvalRuns("rubric_1");
    expect(builder.limit).toHaveBeenCalledWith(100);
  });

  it("maps snake_case db columns to camelCase EvalRun shape", async () => {
    builder._result = {
      data: [
        {
          id: "run_1",
          rubric_id: "rubric_1",
          status: "completed",
          eval_type: "tabular",
          description: "Baseline",
          notification_emails: ["ops@example.com"],
          overall_score: "0.875",
          error_message: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
    const { getEvalRuns } = await import("../eval-runs");
    const [run] = await getEvalRuns("rubric_1");
    expect(run).toEqual({
      id: "run_1",
      rubricId: "rubric_1",
      status: "completed",
      evalType: "tabular",
      description: "Baseline",
      notificationEmails: ["ops@example.com"],
      overallScore: 0.875,
      errorMessage: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });
});

// --- listEvalRunsForInstanceSeed ---

describe("listEvalRunsForInstanceSeed", () => {
  it("returns empty array when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { listEvalRunsForInstanceSeed } = await import("../eval-runs");
    expect(await listEvalRunsForInstanceSeed()).toEqual([]);
  });

  it("returns empty array when the team has no eval runs", async () => {
    builder._result = { data: [], error: null };
    const { listEvalRunsForInstanceSeed } = await import("../eval-runs");
    expect(await listEvalRunsForInstanceSeed()).toEqual([]);
  });

  it("org-scopes the query through the rubric embed, hides soft-deleted runs, and bounds the list", async () => {
    builder._result = { data: [], error: null };
    const { listEvalRunsForInstanceSeed } = await import("../eval-runs");
    await listEvalRunsForInstanceSeed();
    expect(builder.eq).toHaveBeenCalledWith("rubrics.org_id", "org_abc");
    expect(builder.is).toHaveBeenCalledWith("deleted_at", null);
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(builder.limit).toHaveBeenCalledWith(50);
  });

  it("maps a run into the picker option shape with its row count", async () => {
    // A single listed run keeps the shared builder mock deterministic: the run-list read and
    // the one per-run row-count read both resolve off the same `_result`, so `data` (for the
    // list) and `count` (for the count) can share one fixture.
    builder._result = {
      data: [{ id: "run_1", description: "Baseline", created_at: "2026-01-01T00:00:00Z" }],
      count: 12,
      error: null,
    };
    const { listEvalRunsForInstanceSeed } = await import("../eval-runs");
    const rows = await listEvalRunsForInstanceSeed();

    expect(rows).toEqual([
      { id: "run_1", description: "Baseline", createdAt: "2026-01-01T00:00:00Z", rowCount: 12 },
    ]);
  });

  it("defaults rowCount to 0 when the count read yields null", async () => {
    builder._result = {
      data: [{ id: "run_1", description: null, created_at: "2026-01-01T00:00:00Z" }],
      count: null,
      error: null,
    };
    const { listEvalRunsForInstanceSeed } = await import("../eval-runs");
    const [row] = await listEvalRunsForInstanceSeed();
    expect(row.rowCount).toBe(0);
    expect(row.description).toBeNull();
  });
});

// --- getRunCriteriaBreakdown ---

describe("getRunCriteriaBreakdown", () => {
  it("returns empty array when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getRunCriteriaBreakdown } = await import("../eval-runs");
    expect(await getRunCriteriaBreakdown("run_1")).toEqual([]);
  });

  it("returns empty array when run not found or belongs to another team", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { getRunCriteriaBreakdown } = await import("../eval-runs");
    expect(await getRunCriteriaBreakdown("run_1")).toEqual([]);
  });

  it("returns aggregated per-criterion scores for a valid run", async () => {
    builder.maybeSingle.mockResolvedValue({ data: { id: "run_1" }, error: null });
    builder._result = {
      data: [
        { criterion_name: "Accuracy", score: "1.0" },
        { criterion_name: "Accuracy", score: "0.8" },
        { criterion_name: "Tone", score: "0.5" },
        { criterion_name: "Tone", score: "0.5" },
      ],
      error: null,
    };
    const { getRunCriteriaBreakdown } = await import("../eval-runs");
    const result = await getRunCriteriaBreakdown("run_1");
    expect(result).toEqual([
      { name: "Accuracy", score: 0.9 },
      { name: "Tone", score: 0.5 },
    ]);
  });

  it("returns criteria sorted alphabetically by name", async () => {
    builder.maybeSingle.mockResolvedValue({ data: { id: "run_1" }, error: null });
    builder._result = {
      data: [
        { criterion_name: "Tone", score: "0.7" },
        { criterion_name: "Accuracy", score: "0.9" },
        { criterion_name: "Clarity", score: "0.5" },
      ],
      error: null,
    };
    const { getRunCriteriaBreakdown } = await import("../eval-runs");
    const result = await getRunCriteriaBreakdown("run_1");
    expect(result.map((c) => c.name)).toEqual(["Accuracy", "Clarity", "Tone"]);
  });

  it("returns empty array when run has no results", async () => {
    builder.maybeSingle.mockResolvedValue({ data: { id: "run_1" }, error: null });
    builder._result = { data: [], error: null };
    const { getRunCriteriaBreakdown } = await import("../eval-runs");
    expect(await getRunCriteriaBreakdown("run_1")).toEqual([]);
  });
});

// --- getEvalRunDetails ---

describe("getEvalRunDetails", () => {
  it("returns null when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getEvalRunDetails } = await import("../eval-runs");
    expect(await getEvalRunDetails("run_1")).toBeNull();
  });

  it("returns null when run is not found or belongs to another user", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { getEvalRunDetails } = await import("../eval-runs");
    expect(await getEvalRunDetails("run_1")).toBeNull();
  });

  it("returns run details with mapped results on success", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: {
        id: "run_1",
        rubric_id: "rubric_1",
        status: "completed",
        eval_type: "tabular",
        description: null,
        notification_emails: [],
        overall_score: "0.900",
        error_message: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      error: null,
    });
    // Results query ends in .order().order() and is awaited via the thenable.
    builder._result = {
      data: [{ row_index: 0, criterion_name: "Accuracy", score: "0.900", reasoning: "Correct" }],
      error: null,
    };
    const { getEvalRunDetails } = await import("../eval-runs");
    const details = await getEvalRunDetails("run_1");
    expect(details?.overallScore).toBe(0.9);
    expect(details?.results).toEqual([
      { rowIndex: 0, criterionName: "Accuracy", score: 0.9, reasoning: "Correct" },
    ]);
  });
});

// --- getEvalRunComparison ---

const RUN_A_DATA = {
  id: "run_1",
  rubric_id: "rubric_1",
  status: "completed",
  eval_type: "tabular",
  description: "Baseline run",
  notification_emails: [],
  overall_score: "0.800",
  error_message: null,
  created_at: "2026-01-01T00:00:00Z",
};

const RUN_B_DATA = {
  id: "run_2",
  rubric_id: "rubric_1",
  status: "completed",
  eval_type: "tabular",
  description: "Optimized run",
  notification_emails: [],
  overall_score: "0.900",
  error_message: null,
  created_at: "2026-01-15T00:00:00Z",
};

describe("getEvalRunComparison", () => {
  it("returns null when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getEvalRunComparison } = await import("../eval-runs");
    expect(await getEvalRunComparison("run_1", "run_2")).toBeNull();
  });

  it("returns null when run A is not found", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { getEvalRunComparison } = await import("../eval-runs");
    expect(await getEvalRunComparison("run_1", "run_2")).toBeNull();
  });

  it("returns null when run B is not found", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: RUN_A_DATA, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const { getEvalRunComparison } = await import("../eval-runs");
    expect(await getEvalRunComparison("run_1", "run_2")).toBeNull();
  });

  it("returns null when runs belong to different rubrics", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: RUN_A_DATA, error: null })
      .mockResolvedValueOnce({
        data: { ...RUN_B_DATA, rubric_id: "rubric_OTHER" },
        error: null,
      });
    const { getEvalRunComparison } = await import("../eval-runs");
    expect(await getEvalRunComparison("run_1", "run_2")).toBeNull();
  });

  it("returns comparison data with both runs mapped on success", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: RUN_A_DATA, error: null })
      .mockResolvedValueOnce({ data: RUN_B_DATA, error: null });
    // All four thenable sub-queries (rowsA, rowsB, resultsA, resultsB) share _result.
    builder._result = { data: [], error: null };
    const { getEvalRunComparison } = await import("../eval-runs");
    const result = await getEvalRunComparison("run_1", "run_2");
    expect(result).not.toBeNull();
    expect(result?.runA.id).toBe("run_1");
    expect(result?.runB.id).toBe("run_2");
    expect(result?.runA.overallScore).toBe(0.8);
    expect(result?.runB.overallScore).toBe(0.9);
    expect(result?.runA.rows).toEqual([]);
    expect(result?.runB.rows).toEqual([]);
    expect(result?.runA.results).toEqual([]);
    expect(result?.runB.results).toEqual([]);
  });

  it("maps row and result data to camelCase on both sides", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: RUN_A_DATA, error: null })
      .mockResolvedValueOnce({ data: RUN_B_DATA, error: null });
    // The four Promise.all queries share _result.
    builder._result = {
      data: [
        { row_index: 0, user_input: "Hello?", agent_output: "Hi!", expected_output: null },
      ],
      error: null,
    };
    const { getEvalRunComparison } = await import("../eval-runs");
    const result = await getEvalRunComparison("run_1", "run_2");
    // Both sides get the same _result since the mock can't distinguish queries.
    expect(result?.runA.rows[0]).toEqual({
      rowIndex: 0,
      userInput: "Hello?",
      agentOutput: "Hi!",
      expectedOutput: null,
    });
  });

  it("verifies org ownership for both runs via rubrics join", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: RUN_A_DATA, error: null })
      .mockResolvedValueOnce({ data: RUN_B_DATA, error: null });
    builder._result = { data: [], error: null };
    const { getEvalRunComparison } = await import("../eval-runs");
    await getEvalRunComparison("run_1", "run_2");
    expect(builder.eq).toHaveBeenCalledWith("rubrics.org_id", "org_abc");
  });
});
