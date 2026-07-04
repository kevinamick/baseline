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

// Run Gate (#377) — createEvalRun delegates its whole billing pipeline (seat cap,
// missing-key, managed-payment, Eval Point reserve, Managed Spend Cap reserve,
// notifications, rollback) to this seam. Its own refusal matrix and message
// precedence are unit-tested directly in run-gate.test.ts; this file only covers
// createEvalRun's WIRING — the request it builds, and how it reacts to an ok /
// refusal result (including invoking the callbacks it hands the gate).
const mockCheckRunPreflight = vi.fn();
const mockReserveRunOrRefuse = vi.fn();
vi.mock("@/lib/billing/run-gate", () => ({
  checkRunPreflight: mockCheckRunPreflight,
  reserveRunOrRefuse: mockReserveRunOrRefuse,
  // The action localizes refusals at the request boundary; outside a request
  // (this node test) the helper falls back to the en-rendered `error`.
  localizeRunGateError: vi.fn(async (refusal: { error: string }) => refusal.error),
  RUN_KIND: { eval: "eval" },
  KEY_MODE_STRATEGY: { perProvider: "per_provider", judgeAnyByo: "judge_any_byo" },
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
  mockCheckRunPreflight.mockResolvedValue({ ok: true });
  mockReserveRunOrRefuse.mockResolvedValue({
    ok: true,
    plan: "builder",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
  });
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

  // The gate's own refusal matrix (seat cap, missing key, payment-failing, points
  // exhausted, managed cap exceeded) and message precedence are unit-tested directly
  // in run-gate.test.ts. These tests cover createEvalRun's WIRING into the gate: the
  // preflight check runs before any rubric/run-row work, the reserve request carries
  // the right point cost and managed-spend term, and a refusal from either phase
  // short-circuits with its error (and insufficientPoints, when present).

  it("checks the preflight gate before the rubric fetch, and never reserves on refusal", async () => {
    mockCheckRunPreflight.mockResolvedValue({
      ok: false,
      refusal: { kind: "seat_cap", error: "Your team has 2 members but the current plan includes 1" },
    });
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect((result as { error: string }).error).toContain("2 members");
    expect(builder.maybeSingle).not.toHaveBeenCalled();
    expect(mockReserveRunOrRefuse).not.toHaveBeenCalled();
  });

  it("calls checkRunPreflight with eval's key requirement and judge provider", async () => {
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(mockCheckRunPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        runKind: "eval",
        orgId: "org_abc",
        requireProviderKeyForFreePlan: true,
        managedPaymentCheckProviders: ["anthropic"],
      })
    );
  });

  it("reserves the run's exact point cost and its judge managed-spend term via the gate", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "rubric_1", criteria: [{}, {}, {}] },
      error: null,
    });
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    // 2 rows × (base 10 + 3 criteria × 5) = 50
    expect(mockReserveRunOrRefuse).toHaveBeenCalledWith(
      expect.objectContaining({
        runKind: "eval",
        orgId: "org_abc",
        userId: "user_abc",
        runId: "run_1",
        pointReserve: {
          kind: "eval_points",
          pointCost: 50,
          metadata: { row_count: 2, criteria_count: 3, per_row_cost: 25 },
        },
        managedSpendTerms: [
          {
            keyModeStrategy: "judge_any_byo",
            provider: "anthropic",
            model: expect.any(String),
            volume: 2,
            criteriaCount: 3,
          },
        ],
        managedSpendRef: { evalRunId: "run_1" },
      })
    );
  });

  it("hard-stops and returns the gate's refusal, including insufficientPoints", async () => {
    mockReserveRunOrRefuse.mockResolvedValue({
      ok: false,
      refusal: {
        kind: "insufficient_points",
        error: "Not enough Eval Points: this run needs 20, but only 5 remain this period.",
        insufficientPoints: { needed: 20, remaining: 5 },
      },
    });
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toEqual({
      error: "Not enough Eval Points: this run needs 20, but only 5 remain this period.",
      insufficientPoints: { needed: 20, remaining: 5 },
    });
    // The refusal already happened inside the gate — no further run-row work follows.
    expect(builder.rpc).not.toHaveBeenCalledWith("enqueue_eval_run", expect.anything());
  });

  it("omits insufficientPoints from the result when the gate's refusal doesn't carry it", async () => {
    mockReserveRunOrRefuse.mockResolvedValue({
      ok: false,
      refusal: { kind: "managed_cap_exceeded", error: "Couldn't check your team's managed spend cap. Please try again." },
    });
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toEqual({ error: "Couldn't check your team's managed spend cap. Please try again." });
    expect(result).not.toHaveProperty("insufficientPoints");
  });

  it("wires the deleteRun callback to a direct row delete when the gate reserved nothing", async () => {
    mockReserveRunOrRefuse.mockImplementation(async (req) => {
      await req.callbacks.deleteRun();
      return { ok: false, refusal: { kind: "insufficient_points", error: "not enough" } };
    });
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "run_1");
    // A plain delete never touches the settle/release RPCs — nothing was reserved yet.
    expect(builder.rpc).not.toHaveBeenCalledWith("settle_eval_run_points", expect.anything());
  });

  it("wires the rollbackReservations callback to settle points, release managed spend, then delete", async () => {
    mockReserveRunOrRefuse.mockImplementation(async (req) => {
      await req.callbacks.rollbackReservations();
      return { ok: false, refusal: { kind: "managed_cap_exceeded", error: "boom" } };
    });
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toEqual({ error: "boom" });
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_1",
      p_outcome: "skipped",
    });
    expect(builder.rpc).toHaveBeenCalledWith("release_managed_reservation", {
      p_eval_run_id: "run_1",
      p_opt_run_id: null,
    });
    expect(builder.delete).toHaveBeenCalled();
  });

  it("releases the reservation before rolling back when rows insert fails", async () => {
    builder._result = { data: null, error: { message: "constraint violation" } };
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_1",
      p_outcome: "skipped",
    });
    // The managed reservation releases too, BEFORE the delete nulls the managed ledger's FK —
    // an orphaned reserve (eval_run_id = null) is unfindable and pins committed spend all period.
    expect(builder.rpc).toHaveBeenCalledWith("release_managed_reservation", {
      p_eval_run_id: "run_1",
      p_opt_run_id: null,
    });
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
    // rollBackRun settles (releasing the reservation) then deletes the half-created run.
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_1",
      p_outcome: "skipped",
    });
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
