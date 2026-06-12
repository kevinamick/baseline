import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  insert: Mock;
  upsert: Mock;
  delete: Mock;
  eq: Mock;
  in: Mock;
  order: Mock;
  single: Mock;
  maybeSingle: Mock;
  rpc: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

// --- Mocks ---

const mockGetAuthContext = vi.fn();
const mockTrack = vi.fn();
const mockFetch = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));

vi.stubGlobal("fetch", mockFetch);


const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  in: vi.fn(),
  order: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  // Makes the builder thenable so chains ending in a raw method can be awaited.
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

for (const method of ["from", "select", "insert", "upsert", "delete", "eq", "in", "order"] as const) {
  builder[method].mockReturnValue(builder);
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: builder,
}));

// Point reservation (#180) — mocked at the module seam; the SQL atomicity is
// covered by the ledger integration tests, this file covers the wiring.
const mockReserve = vi.fn();
vi.mock("@/lib/billing/ledger", () => ({ reserveEvalRunPoints: mockReserve }));

const mockListOrgMembers = vi.fn();
const mockGetOrgName = vi.fn();
vi.mock("@/lib/auth/members", () => ({
  listOrgMembers: mockListOrgMembers,
  getOrgName: mockGetOrgName,
}));

const mockSendEmail = vi.fn();
vi.mock("@/lib/email/send", () => ({ sendEmail: mockSendEmail }));

const mockSeatCap = vi.fn();
vi.mock("@/lib/billing/seats", () => ({ getSeatCapState: mockSeatCap }));

// --- Fixtures ---

const sampleRows = [
  { userInput: "What is 2+2?", agentOutput: "4" },
  { userInput: "Capital of France?", agentOutput: "Paris", expectedOutput: "Paris" },
];

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", role: "admin", canWrite: true });
  builder._result = { data: null, error: null };
  builder.single.mockResolvedValue({ data: { id: "run_1" }, error: null });
  // Default: rubric ownership check passes, run detail lookup returns nothing.
  // Tests that need different behaviour override maybeSingle individually.
  builder.maybeSingle.mockResolvedValue({ data: { id: "rubric_1" }, error: null });
  builder.rpc.mockResolvedValue({ error: null });
  mockFetch.mockResolvedValue({ ok: true });
  mockReserve.mockResolvedValue({
    reserved: true,
    balance: 1_000,
    periodStart: "2026-06-01T00:00:00.000Z",
  });
  mockListOrgMembers.mockResolvedValue([
    { userId: "user_abc", email: "admin@example.com", role: "admin" },
    { userId: "user_def", email: "viewer@example.com", role: "member" },
  ]);
  mockGetOrgName.mockResolvedValue("Acme");
  mockSendEmail.mockResolvedValue(undefined);
  mockSeatCap.mockResolvedValue({ violated: false, memberCount: 1, seatLimit: null });
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

  it("refuses runs while the team exceeds its plan's seats (#182 fail-closed)", async () => {
    mockSeatCap.mockResolvedValue({ violated: true, memberCount: 2, seatLimit: 1 });
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect((result as { error: string }).error).toContain("2 members");
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("reserves the run's exact point cost with its reservation context", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { id: "rubric_1", criteria: [{}, {}, {}] },
      error: null,
    });
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    // 2 rows × (base 10 + 3 criteria × 5) = 50
    expect(mockReserve).toHaveBeenCalledWith("org_abc", "run_1", 50, {
      row_count: 2,
      criteria_count: 3,
      per_row_cost: 25,
    });
  });

  it("hard-stops on refusal: rolls back the run, emails Contributors only, returns the numbers", async () => {
    mockReserve.mockResolvedValue({
      reserved: false,
      balance: 5,
      periodStart: "2026-06-01T00:00:00.000Z",
    });
    // The notification-throttle upsert claims the period (returns a row).
    builder._result = { data: [{ org_id: "org_abc" }], error: null };
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });

    // 2 rows × base 10 (rubric fixture has no criteria array) = 20 needed.
    expect(result).toMatchObject({
      insufficientPoints: { needed: 20, remaining: 5 },
    });
    expect((result as { error: string }).error).toContain("Not enough Eval Points");
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.rpc).not.toHaveBeenCalledWith("enqueue_eval_run", expect.anything());
    // The limit email goes to admins, never readonly members.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "billing.points_limit_hit",
        props: { team_id: "org_abc", needed: 20, remaining: 5 },
      }),
      { userId: "user_abc" }
    );
  });

  it("clamps negative balances to zero in the refusal message", async () => {
    mockReserve.mockResolvedValue({
      reserved: false,
      balance: -40,
      periodStart: "2026-06-01T00:00:00.000Z",
    });
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toMatchObject({ insufficientPoints: { remaining: 0 } });
  });

  it("sends no limit email when another refusal already claimed the period", async () => {
    mockReserve.mockResolvedValue({
      reserved: false,
      balance: 5,
      periodStart: "2026-06-01T00:00:00.000Z",
    });
    // ignoreDuplicates upsert returns no rows → someone already notified.
    builder._result = { data: [], error: null };
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toMatchObject({ insufficientPoints: { needed: 20, remaining: 5 } });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("still hard-stops when the limit email fails", async () => {
    mockReserve.mockResolvedValue({
      reserved: false,
      balance: 0,
      periodStart: "2026-06-01T00:00:00.000Z",
    });
    builder._result = { data: [{ org_id: "org_abc" }], error: null };
    mockSendEmail.mockRejectedValue(new Error("smtp down"));
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toMatchObject({ insufficientPoints: { needed: 20, remaining: 0 } });
  });

  it("fails closed when the reservation check itself errors, releasing any committed reservation", async () => {
    mockReserve.mockRejectedValue(new Error("ledger unreachable"));
    const { createEvalRun } = await import("../eval-runs");
    const result = await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(result).toEqual({
      error: "Couldn't check your team's Eval Point balance. Please try again.",
    });
    // The RPC may have committed before the response was lost — release runs
    // BEFORE the run row's delete nulls the ledger FK.
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_1",
      p_outcome: "skipped",
    });
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.rpc).not.toHaveBeenCalledWith("enqueue_eval_run", expect.anything());
  });

  it("releases the reservation before rolling back when rows insert fails", async () => {
    builder._result = { data: null, error: { message: "constraint violation" } };
    const { createEvalRun } = await import("../eval-runs");
    await createEvalRun("rubric_1", sampleRows, { inputSource: "manual" });
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_1",
      p_outcome: "skipped",
    });
  });

  it("rolls the run back when enqueue fails — a run that never queues would pin its reservation", async () => {
    builder.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "enqueue_eval_run" ? { error: { message: "pgmq unavailable" } } : { error: null }
      )
    );
    const { createEvalRun } = await import("../eval-runs");
    expect(await createEvalRun("rubric_1", sampleRows, { inputSource: "file" })).toEqual({
      error: "Couldn't queue the eval run. Please try again.",
    });
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_1",
      p_outcome: "skipped",
    });
    expect(builder.delete).toHaveBeenCalled();
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
