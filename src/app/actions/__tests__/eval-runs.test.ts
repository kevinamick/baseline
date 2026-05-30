import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  insert: Mock;
  delete: Mock;
  eq: Mock;
  order: Mock;
  single: Mock;
  maybeSingle: Mock;
  rpc: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

// --- Mocks ---

const mockAuth = vi.fn();
const mockTrack = vi.fn();
const mockFetch = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));

vi.stubGlobal("fetch", mockFetch);


const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  // Makes the builder thenable so chains ending in a raw method can be awaited.
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

for (const method of ["from", "select", "insert", "delete", "eq", "order"] as const) {
  builder[method].mockReturnValue(builder);
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: builder,
}));

// --- Fixtures ---

const sampleRows = [
  { userInput: "What is 2+2?", agentOutput: "4" },
  { userInput: "Capital of France?", agentOutput: "Paris", expectedOutput: "Paris" },
];

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", orgRole: "org:admin" });
  builder._result = { data: null, error: null };
  builder.single.mockResolvedValue({ data: { id: "run_1" }, error: null });
  // Default: rubric ownership check passes, run detail lookup returns nothing.
  // Tests that need different behaviour override maybeSingle individually.
  builder.maybeSingle.mockResolvedValue({ data: { id: "rubric_1" }, error: null });
  builder.rpc.mockResolvedValue({ error: null });
  mockFetch.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- createEvalRun ---

describe("createEvalRun", () => {
  it("returns error when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
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

  it("returns runId even when enqueue rpc fails", async () => {
    builder.rpc.mockResolvedValue({ error: { message: "pgmq unavailable" } });
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "file" })).toEqual({
      runId: "run_1",
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

  it("POSTs to WORKER_WAKE_URL after a successful enqueue", async () => {
    process.env.WORKER_WAKE_URL = "https://baseline-eval-worker.fly.dev/wake";
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    await vi.runAllTimersAsync().catch(() => {});
    expect(mockFetch).toHaveBeenCalledWith(
      "https://baseline-eval-worker.fly.dev/wake",
      { method: "POST" }
    );
    delete process.env.WORKER_WAKE_URL;
  });

  it("includes Authorization header when WORKER_WAKE_SECRET is set", async () => {
    process.env.WORKER_WAKE_URL = "https://baseline-eval-worker.fly.dev/wake";
    process.env.WORKER_WAKE_SECRET = "s3cr3t";
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    await vi.runAllTimersAsync().catch(() => {});
    expect(mockFetch).toHaveBeenCalledWith(
      "https://baseline-eval-worker.fly.dev/wake",
      { method: "POST", headers: { Authorization: "Bearer s3cr3t" } }
    );
    delete process.env.WORKER_WAKE_URL;
    delete process.env.WORKER_WAKE_SECRET;
  });

  it("does not call fetch when WORKER_WAKE_URL is not set", async () => {
    delete process.env.WORKER_WAKE_URL;
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    await vi.runAllTimersAsync().catch(() => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not call fetch when enqueue fails", async () => {
    process.env.WORKER_WAKE_URL = "https://baseline-eval-worker.fly.dev/wake";
    builder.rpc.mockResolvedValue({ error: { message: "pgmq unavailable" } });
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    await vi.runAllTimersAsync().catch(() => {});
    expect(mockFetch).not.toHaveBeenCalled();
    delete process.env.WORKER_WAKE_URL;
  });

  it("still returns runId when the wake fetch rejects", async () => {
    process.env.WORKER_WAKE_URL = "https://baseline-eval-worker.fly.dev/wake";
    mockFetch.mockRejectedValue(new Error("network error"));
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toEqual({ runId: "run_1" });
    delete process.env.WORKER_WAKE_URL;
  });
});

// --- getEvalRuns ---

describe("getEvalRuns", () => {
  it("returns empty array when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
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

// --- getEvalRunDetails ---

describe("getEvalRunDetails", () => {
  it("returns null when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
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
