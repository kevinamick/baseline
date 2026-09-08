import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

// --- Mocks ---
// The Activities read/write Postgres through one supabase client. The stub below hands every
// query chain back a recording builder; awaiting a chain (thenable / maybeSingle / single)
// consumes the next queued result, in execution order. Tests queue results to drive each
// path and assert on the recorded calls (table + method + args) for persistence shapes.

interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

const db = vi.hoisted(() => ({
  results: [] as unknown[],
  calls: [] as RecordedCall[],
  rpc: vi.fn(),
  next(): unknown {
    return db.results.length > 0 ? db.results.shift() : { data: null, error: null, count: null };
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of [
        "select",
        "insert",
        "update",
        "upsert",
        "delete",
        "eq",
        "in",
        "order",
        "limit",
        "range",
      ]) {
        builder[method] = (...args: unknown[]) => {
          db.calls.push({ table, method, args });
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(db.next());
      builder.single = () => Promise.resolve(db.next());
      builder.then = (resolve: (v: unknown) => void) => resolve(db.next());
      return builder;
    },
    rpc: db.rpc,
  }),
}));

const {
  mockJudge,
  mockInvokeAgent,
  mockInvokeManaged,
  mockAdapter,
  mockSendCompletion,
  mockSendFailure,
  mockTrack,
  mockResolveEvalJudge,
  mockResolveProviderKey,
  mockCaptureException,
} = vi.hoisted(() => ({
  mockJudge: vi.fn(),
  mockInvokeAgent: vi.fn(),
  mockInvokeManaged: vi.fn(),
  mockAdapter: vi.fn(),
  mockSendCompletion: vi.fn(),
  mockSendFailure: vi.fn(),
  mockTrack: vi.fn(),
  mockResolveEvalJudge: vi.fn(),
  mockResolveProviderKey: vi.fn(),
  mockCaptureException: vi.fn(),
}));

// The judge provider is resolved via the factory (createProviderForModel), so the key
// seams below drive it; the provider's judge() is the mock so evaluateRun's real per-row
// fan-out runs unchanged.
vi.mock("../providers/factory.js", () => ({
  createProviderForModel: () => ({ judge: mockJudge }),
  createProvider: () => ({ judge: mockJudge }),
}));
vi.mock("../providers/resolve-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/resolve-key.js")>()),
  resolveEvalJudge: mockResolveEvalJudge,
  resolveProviderKey: mockResolveProviderKey,
}));
vi.mock("../agent.js", () => ({
  invokeAgent: mockInvokeAgent,
  invokeManagedAgent: mockInvokeManaged,
}));
vi.mock("../adapters/index.js", () => ({ getDatasetAdapter: () => mockAdapter }));
vi.mock("../emailer.js", () => ({
  sendCompletionEmail: mockSendCompletion,
  sendFailureEmail: mockSendFailure,
}));
vi.mock("../telemetry.js", () => ({
  trackRunCompleted: mockTrack,
  captureException: mockCaptureException,
}));

import {
  prepareEvalRun,
  invokeAgentRow,
  judgeEvalRun,
  completeEvalRun,
  failEvalRun,
  failRunQuietly,
} from "./activities.js";
import { AGENT_KIND, DATASET_KIND, MANUAL_KIND, READY, SKIPPED } from "./kind.js";

const RUN_ID = "run-1";

// -- result fixtures, queued in each activity's query execution order --

const runRow = (over: Record<string, unknown> = {}) => ({
  data: {
    id: RUN_ID,
    rubric_id: "rubric-1",
    schedule_id: null,
    eval_type: "tabular",
    ...over,
  },
  error: null,
});

// loadOrgId (rubrics.select org_id) runs right after loadEvalRun on the judge + managed-agent
// paths — the org every key seam is scoped to.
const orgRow = { data: { org_id: "org-1" }, error: null };

// The Anthropic judge model used by the judge fixtures.
const PRICED_JUDGE_MODEL = "claude-haiku-4-5-20251001";

const rubricRow = {
  data: {
    name: "Support quality",
    scenario_description: "scenario",
    expected_outcome: "outcome",
    grounding_context: null,
    criteria: [
      { name: "Accuracy", weight: 0.6, steps: ["check facts"] },
      { name: "Tone", weight: 0.4, steps: ["check tone"] },
    ],
  },
  error: null,
};

const dataRows = {
  data: [
    {
      row_index: 0,
      user_input: "q0",
      agent_output: "a0",
      expected_output: null,
      retrieval_context: null,
    },
    {
      row_index: 1,
      user_input: "q1",
      agent_output: "a1",
      expected_output: null,
      retrieval_context: null,
    },
  ],
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.results = [];
  db.calls = [];
  db.rpc.mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Key defaults: a saved Anthropic judge key.
  mockResolveEvalJudge.mockResolvedValue({
    provider: "anthropic",
    judgeModel: PRICED_JUDGE_MODEL,
    resolved: { source: "byo", key: "sk-byo" },
  });
  mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
});

function callsTo(table: string, method: string): RecordedCall[] {
  return db.calls.filter((c) => c.table === table && c.method === method);
}

// --- prepareEvalRun ---

describe("prepareEvalRun", () => {
  it("manual run: claims queued→running and returns its row indexes", async () => {
    db.results = [
      runRow(), // load run
      orgRow, // loadOrgId (rubrics select org_id)
      { data: { id: RUN_ID }, error: null }, // claim
      { data: [{ row_index: 0 }, { row_index: 1 }], error: null }, // row indexes
    ];

    const prep = await prepareEvalRun(RUN_ID);

    expect(prep).toEqual({ outcome: READY, kind: MANUAL_KIND, rowIndexes: [0, 1], agentFanoutConcurrency: 5 });
    const claim = callsTo("eval_runs", "update")[0];
    expect(claim.args[0]).toMatchObject({ status: "running" });
    const inCall = callsTo("eval_runs", "in")[0];
    expect(inCall.args).toEqual(["status", ["queued", "running"]]);
  });

  it("returns the EVAL_AGENT_FANOUT_CONCURRENCY override, resolved in Activity/Node context", async () => {
    // The workflow can't read env from Temporal's deterministic sandbox, so the cap is resolved
    // here (once at module load) and RIDES the Activity result. Proving the override — not just
    // the default 5 — closes the determinism contract: set the env, re-import the module fresh so
    // the module-load parse runs again, and confirm the value flows back through prepareEvalRun.
    vi.stubEnv("EVAL_AGENT_FANOUT_CONCURRENCY", "9");
    vi.resetModules();
    const { prepareEvalRun: freshPrepare } = await import("./activities.js");

    db.results = [
      runRow(),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: [{ row_index: 0 }, { row_index: 1 }], error: null },
    ];

    const prep = await freshPrepare(RUN_ID);
    expect(prep).toEqual({ outcome: READY, kind: MANUAL_KIND, rowIndexes: [0, 1], agentFanoutConcurrency: 9 });
    vi.unstubAllEnvs();
  });

  it("throws a nonRetryable failure when the rubric is gone (terminal misconfiguration)", async () => {
    db.results = [
      runRow(),
      { data: null, error: null }, // rubric missing
    ];

    const thrown = await prepareEvalRun(RUN_ID).catch((err) => err);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toBe("Rubric not found");
  });

  it("throws nonRetryably when a manual run has no input rows", async () => {
    db.results = [
      runRow(),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: [], error: null }, // no rows
    ];

    const thrown = await prepareEvalRun(RUN_ID).catch((err) => err);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toBe("No input rows found");
  });

  it("agent schedule: reports the agent kind so the workflow fans out invocations", async () => {
    db.results = [
      runRow({ schedule_id: "sched-1" }),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
      { data: { id: "conn-1", kind: "agent", provider: "custom", auth_secret_id: null }, error: null },
      { data: [{ row_index: 0 }], error: null },
    ];

    const prep = await prepareEvalRun(RUN_ID);
    expect(prep).toEqual({ outcome: READY, kind: AGENT_KIND, rowIndexes: [0], agentFanoutConcurrency: 5 });
  });

  it("dataset schedule: fetches the window's rows from the source and persists them", async () => {
    db.results = [
      runRow({ schedule_id: "sched-1" }),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: { connection_id: "conn-1", window_minutes: 60, max_rows: 100 }, error: null },
      { data: { id: "conn-1", kind: "dataset", provider: "custom", auth_secret_id: null }, error: null },
      { count: 0, error: null }, // no rows persisted yet
      { data: null, error: null }, // rows upsert
      { data: [{ row_index: 0 }, { row_index: 1 }], error: null },
    ];
    mockAdapter.mockResolvedValue([
      { user_input: "q0", agent_output: "a0", expected_output: null, retrieval_context: null },
      { user_input: "q1", agent_output: "a1", expected_output: null, retrieval_context: null },
      { user_input: "  ", agent_output: "dropped", expected_output: null, retrieval_context: null },
    ]);

    const prep = await prepareEvalRun(RUN_ID);

    expect(prep).toEqual({ outcome: READY, kind: DATASET_KIND, rowIndexes: [0, 1], agentFanoutConcurrency: 5 });
    const upsert = callsTo("eval_run_rows", "upsert")[0];
    expect(upsert.args[0]).toEqual([
      expect.objectContaining({ eval_run_id: RUN_ID, row_index: 0, user_input: "q0", agent_output: "a0" }),
      expect.objectContaining({ eval_run_id: RUN_ID, row_index: 1, user_input: "q1", agent_output: "a1" }),
    ]);
    expect(upsert.args[1]).toEqual({ onConflict: "eval_run_id,row_index" });
  });

  it("dataset schedule with a quiet window: marks the run skipped (terminal, no failure)", async () => {
    db.results = [
      runRow({ schedule_id: "sched-1" }),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: { connection_id: "conn-1", window_minutes: 60, max_rows: 100 }, error: null },
      { data: { id: "conn-1", kind: "dataset", provider: "custom", auth_secret_id: null }, error: null },
      { count: 0, error: null },
      { data: { id: RUN_ID }, error: null }, // skipped status update — row transitioned
    ];
    mockAdapter.mockResolvedValue([]);

    const prep = await prepareEvalRun(RUN_ID);

    expect(prep).toEqual({ outcome: SKIPPED });
    const updates = callsTo("eval_runs", "update");
    expect(updates[updates.length - 1].args[0]).toMatchObject({
      status: "skipped",
      error_message: "No rows returned for the configured window",
    });
  });
});

// --- invokeAgentRow ---

describe("invokeAgentRow", () => {
  // The run/schedule/connection context is cached per run id (module state), so each test
  // uses its own run id to stay independent.
  const inputRow = (rowIndex: number, agentOutput: string) => ({
    data: {
      row_index: rowIndex,
      user_input: `q${rowIndex}`,
      agent_output: agentOutput,
      expected_output: null,
      retrieval_context: null,
    },
    error: null,
  });
  // Queries resolving the per-run agent context (run → org → schedule → connection), in order.
  const contextQueries = (runId: string, authSecretId: string | null = null) => [
    runRow({ id: runId, schedule_id: "sched-1" }),
    orgRow,
    { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
    {
      data: {
        id: "conn-1",
        kind: "agent",
        provider: "custom",
        auth_secret_id: authSecretId,
        agent_kind: "external",
        target_model: null,
      },
      error: null,
    },
  ];

  it("invokes the agent Connection live and persists the output on the row", async () => {
    const runId = "run-invoke";
    db.results = [
      inputRow(0, ""),
      ...contextQueries(runId),
      { data: null, error: null }, // output update
    ];
    mockInvokeAgent.mockResolvedValue("live answer");

    await invokeAgentRow({ evalRunId: runId, rowIndex: 0 });

    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn-1", kind: "agent" }),
      expect.objectContaining({ row_index: 0, user_input: "q0" }),
      null
    );
    const update = callsTo("eval_run_rows", "update")[0];
    expect(update.args[0]).toEqual({ agent_output: "live answer" });
  });

  it("skips a row whose output is already persisted (idempotent retry)", async () => {
    db.results = [inputRow(0, "already filled")];

    await invokeAgentRow({ evalRunId: "run-skip", rowIndex: 0 });

    expect(mockInvokeAgent).not.toHaveBeenCalled();
    expect(callsTo("eval_run_rows", "update")).toEqual([]);
  });

  it("resolves the run's context (and credential decrypt) once, reused across rows", async () => {
    const runId = "run-cached";
    db.rpc.mockResolvedValue({ data: "Bearer secret", error: null });
    db.results = [
      inputRow(0, ""),
      ...contextQueries(runId, "sec-1"),
      { data: null, error: null }, // row 0 output update
      inputRow(1, ""), // row 1: only the row query — context comes from the cache
      { data: null, error: null }, // row 1 output update
    ];
    mockInvokeAgent.mockResolvedValue("answer");

    await invokeAgentRow({ evalRunId: runId, rowIndex: 0 });
    await invokeAgentRow({ evalRunId: runId, rowIndex: 1 });

    expect(db.rpc).toHaveBeenCalledTimes(1); // one decrypt for the whole run
    expect(callsTo("schedules", "select")).toHaveLength(1);
    expect(callsTo("connections", "select")).toHaveLength(1);
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
    expect(mockInvokeAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "conn-1" }),
      expect.objectContaining({ row_index: 1 }),
      "Bearer secret"
    );
  });

  it("does not cache a failed context resolution (a retried row re-resolves)", async () => {
    const runId = "run-ctx-fail";
    db.results = [
      inputRow(0, ""),
      { data: null, error: { message: "load run blew up" } }, // context: run load fails
      inputRow(0, ""), // retry: row again
      ...contextQueries(runId), // retry: context re-resolved, not a cached rejection
      { data: null, error: null },
    ];
    mockInvokeAgent.mockResolvedValue("answer");

    await expect(invokeAgentRow({ evalRunId: runId, rowIndex: 0 })).rejects.toThrow(
      "Failed to load eval run: load run blew up"
    );
    await expect(invokeAgentRow({ evalRunId: runId, rowIndex: 0 })).resolves.toBeUndefined();
    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
  });
});

// --- judgeEvalRun ---

describe("judgeEvalRun", () => {
  it("persists per-criterion scores and reasoning, returning the weighted overall score", async () => {
    db.results = [
      runRow(),
      orgRow,
      rubricRow,
      dataRows,
      { data: [], error: null }, // no results persisted yet (fresh attempt)
      { data: null, error: null }, // chunk results upsert (both rows fit one chunk)
    ];
    // Per evaluateRun's loop order (row 0: Accuracy, Tone; row 1: Accuracy, Tone).
    mockJudge
      .mockResolvedValueOnce({ score: 1.0, reasoning: "r0 accurate" })
      .mockResolvedValueOnce({ score: 0.5, reasoning: "r0 tone ok" })
      .mockResolvedValueOnce({ score: 1.0, reasoning: "r1 accurate" })
      .mockResolvedValueOnce({ score: 0.5, reasoning: "r1 tone ok" });

    const result = await judgeEvalRun({ evalRunId: RUN_ID });

    // Accuracy avg 1.0 * 0.6 + Tone avg 0.5 * 0.4
    expect(result).toEqual({ overallScore: 0.8, rowCount: 2 });

    // Checkpointed per CHUNK: both rows fit one chunk, so their results land in one upsert
    // (cross-row fan-out inside the chunk restores the old executor's judge concurrency).
    const upserts = callsTo("eval_run_results", "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].args[0]).toEqual([
      { eval_run_id: RUN_ID, row_index: 0, criterion_name: "Accuracy", score: 1.0, reasoning: "r0 accurate" },
      { eval_run_id: RUN_ID, row_index: 0, criterion_name: "Tone", score: 0.5, reasoning: "r0 tone ok" },
      { eval_run_id: RUN_ID, row_index: 1, criterion_name: "Accuracy", score: 1.0, reasoning: "r1 accurate" },
      { eval_run_id: RUN_ID, row_index: 1, criterion_name: "Tone", score: 0.5, reasoning: "r1 tone ok" },
    ]);
    // Retry-safe persistence: upsert on the run's unique result key, not a bare insert.
    expect(upserts[0].args[1]).toEqual({ onConflict: "eval_run_id,row_index,criterion_name" });
  });

  it("resumes from the checkpoint: fully-judged rows are not re-judged on retry", async () => {
    db.results = [
      runRow(),
      orgRow,
      rubricRow,
      dataRows,
      {
        // Row 0 was fully judged (and persisted) by the timed-out earlier attempt.
        data: [
          { row_index: 0, criterion_name: "Accuracy", score: 1.0, reasoning: "r0 accurate" },
          { row_index: 0, criterion_name: "Tone", score: 0.5, reasoning: "r0 tone ok" },
        ],
        error: null,
      },
      { data: null, error: null }, // row 1 results upsert
    ];
    mockJudge
      .mockResolvedValueOnce({ score: 1.0, reasoning: "r1 accurate" })
      .mockResolvedValueOnce({ score: 0.5, reasoning: "r1 tone ok" });

    const result = await judgeEvalRun({ evalRunId: RUN_ID });

    // Only row 1's two criteria hit the LLM judge — row 0's calls are not re-spent.
    expect(mockJudge).toHaveBeenCalledTimes(2);
    const upserts = callsTo("eval_run_results", "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].args[0]).toEqual([
      { eval_run_id: RUN_ID, row_index: 1, criterion_name: "Accuracy", score: 1.0, reasoning: "r1 accurate" },
      { eval_run_id: RUN_ID, row_index: 1, criterion_name: "Tone", score: 0.5, reasoning: "r1 tone ok" },
    ]);
    // Overall score spans resumed + fresh results, same weighting as a single pass.
    expect(result).toEqual({ overallScore: 0.8, rowCount: 2 });
  });

  it("fails when persisting results fails (the run must not complete without results)", async () => {
    db.results = [
      runRow(),
      orgRow,
      rubricRow,
      dataRows,
      { data: [], error: null }, // no prior results
      { data: null, error: { message: "disk full" } }, // row 0 upsert fails
    ];
    mockJudge.mockResolvedValue({ score: 1.0, reasoning: "ok" });

    await expect(judgeEvalRun({ evalRunId: RUN_ID })).rejects.toThrow(
      "Failed to save results: disk full"
    );
  });
});

// --- completeEvalRun / failEvalRun ---

describe("completeEvalRun", () => {
  it("marks the run completed with its score and sends the completion email", async () => {
    db.results = [
      { data: { id: RUN_ID }, error: null }, // guarded status update — row transitioned
      { data: { notification_emails: ["ops@example.com"], rubrics: { name: "Support quality" } }, error: null },
    ];

    await completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 });

    const update = callsTo("eval_runs", "update")[0];
    expect(update.args[0]).toMatchObject({ status: "completed", overall_score: 0.8 });
    // Guarded transition: only a 'running' run may complete.
    expect(callsTo("eval_runs", "in").map((c) => c.args)).toContainEqual(["status", ["running"]]);
    expect(mockSendCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["ops@example.com"],
        runId: RUN_ID,
        rubricName: "Support quality",
        overallScore: 0.8,
        rowCount: 2,
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(RUN_ID, 0.8, 2);
  });

  it("retry after an earlier completion: no second email, no double telemetry", async () => {
    // Guard matched no row (run already 'completed' from the first attempt).
    db.results = [{ data: null, error: null }];

    await completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 });

    expect(mockSendCompletion).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("does not email when the run has no recipients, and never throws on email failure", async () => {
    db.results = [
      { data: { id: RUN_ID }, error: null },
      { data: { notification_emails: [], rubrics: { name: "Support quality" } }, error: null },
    ];
    await completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 });
    expect(mockSendCompletion).not.toHaveBeenCalled();

    db.results = [
      { data: { id: RUN_ID }, error: null },
      { data: { notification_emails: ["ops@example.com"], rubrics: { name: "R" } }, error: null },
    ];
    mockSendCompletion.mockRejectedValue(new Error("smtp down"));
    await expect(
      completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 })
    ).resolves.toBeUndefined();
  });
});

describe("failEvalRun", () => {
  it("marks the run failed with the clear reason (Postgres only) and emails", async () => {
    db.results = [
      { data: { id: RUN_ID }, error: null }, // guarded status update — row transitioned
      {
        data: {
          notification_emails: ["ops@example.com"],
          created_at: new Date().toISOString(),
          rubrics: { name: "Support quality" },
        },
        error: null,
      },
    ];

    await failEvalRun({ evalRunId: RUN_ID, message: "Agent endpoint returned HTTP 500" });

    const update = callsTo("eval_runs", "update")[0];
    expect(update.args[0]).toMatchObject({
      status: "failed",
      error_message: "Agent endpoint returned HTTP 500",
    });
    // Guarded transition: only a non-terminal run may be failed.
    expect(callsTo("eval_runs", "in").map((c) => c.args)).toContainEqual([
      "status",
      ["queued", "running"],
    ]);
    // Postgres stays the source of truth, and the failure ALSO reaches error tracking
    // (restored per review follow-up) — guarded by the flip so retries can't double-report.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Agent endpoint returned HTTP 500" }),
      expect.objectContaining({ run_id: RUN_ID })
    );
    expect(mockSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["ops@example.com"],
        runId: RUN_ID,
        rubricName: "Support quality",
        errorMessage: "Agent endpoint returned HTTP 500",
      })
    );
  });

  it("never overwrites a terminal state: a skipped/completed run stays put, no email", async () => {
    // Guard matched no row (run is already 'skipped' — e.g. a retried prepareEvalRun whose
    // first attempt marked a quiet dataset window, then saw "already terminal").
    db.results = [
      { data: null, error: null }, // guarded update: no transition
    ];

    await failEvalRun({ evalRunId: RUN_ID, message: "Eval run is already in a terminal state" });

    expect(mockSendFailure).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    // Only the guarded update — no status read, no notification lookup.
    expect(callsTo("eval_runs", "select").map((c) => c.args)).toEqual([["id"]]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("throws when the terminal write fails, so Temporal retries the Activity", async () => {
    db.results = [{ data: null, error: { message: "connection reset" } }];

    await expect(failEvalRun({ evalRunId: RUN_ID, message: "boom" })).rejects.toThrow(
      "Failed to mark eval run failed: connection reset"
    );
    expect(mockSendFailure).not.toHaveBeenCalled();
  });

  it("still records the failure when the notification lookup blows up", async () => {
    db.results = [
      { data: { id: RUN_ID }, error: null },
      { data: null, error: { message: "join failed" } },
    ];

    await expect(
      failEvalRun({ evalRunId: RUN_ID, message: "boom" })
    ).resolves.toBeUndefined();
    expect(mockSendFailure).not.toHaveBeenCalled();
  });
});

// --- review-fix regression tests (PR #161 review) ---

describe("prepareEvalRun judge-key fail-fast", () => {
  it("fails terminally BEFORE claiming or reserving when no judge key resolves", async () => {
    mockResolveEvalJudge.mockResolvedValue({
      provider: "anthropic",
      judgeModel: PRICED_JUDGE_MODEL,
      resolved: { source: "none", key: null },
    });
    db.results = [runRow({ schedule_id: "sched-1" }), orgRow];

    const thrown = await prepareEvalRun(RUN_ID).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    // Old-executor parity: the run dies with the clear reason and ZERO side effects — no
    // queued→running claim, and (because the workflow never reaches the fan-out) no agent
    // invocation for a run guaranteed to fail at judging.
    expect(callsTo("eval_runs", "update")).toHaveLength(0);
  });
});

describe("paged reads (review fix: PostgREST max_rows truncation)", () => {
  it("pages the judge checkpoint read past 1,000 results instead of re-judging them", async () => {
    // 2 rows judged already, but the checkpoint arrives as one FULL page (1000) + a remainder —
    // an unpaged read would have returned only the first page and re-judged everything after it.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      row_index: Math.floor(i / 2),
      criterion_name: i % 2 === 0 ? "Accuracy" : "Tone",
      score: 1,
      reasoning: "done",
    }));
    // Remainder covers the tail so every row of the run is already judged.
    const remainder = [
      { row_index: 500, criterion_name: "Accuracy", score: 1, reasoning: "done" },
      { row_index: 500, criterion_name: "Tone", score: 1, reasoning: "done" },
    ];
    const rows501 = {
      data: Array.from({ length: 501 }, (_, i) => ({
        row_index: i,
        user_input: `q${i}`,
        agent_output: `a${i}`,
        expected_output: null,
        retrieval_context: null,
      })),
      error: null,
    };
    db.results = [
      runRow(),
      orgRow,
      rubricRow,
      rows501, // rows page 1 (short → single page)
      { data: fullPage, error: null }, // results page 1 (FULL → keep paging)
      { data: remainder, error: null }, // results page 2 (short → stop)
    ];

    const result = await judgeEvalRun({ evalRunId: RUN_ID });

    // Every (row × criterion) pair was found in the checkpoint: nothing re-judged, no upserts.
    expect(mockJudge).not.toHaveBeenCalled();
    expect(callsTo("eval_run_results", "upsert")).toHaveLength(0);
    expect(result.rowCount).toBe(501);
    // The read genuinely paged: range(0,999) then range(1000,1999).
    const resultRanges = callsTo("eval_run_results", "range").map((c) => c.args);
    expect(resultRanges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});

describe("judge chunking (review fix: cross-row fan-out + checkpoint granularity)", () => {
  it("judges in row chunks: >20 pending rows produce one upsert per chunk", async () => {
    const manyRows = {
      data: Array.from({ length: 21 }, (_, i) => ({
        row_index: i,
        user_input: `q${i}`,
        agent_output: `a${i}`,
        expected_output: null,
        retrieval_context: null,
      })),
      error: null,
    };
    db.results = [
      runRow(),
      orgRow,
      rubricRow,
      manyRows,
      { data: [], error: null }, // no checkpoint
      { data: null, error: null }, // chunk 1 upsert (rows 0-19)
      { data: null, error: null }, // chunk 2 upsert (row 20)
    ];
    mockJudge.mockResolvedValue({ score: 1, reasoning: "ok" });

    await judgeEvalRun({ evalRunId: RUN_ID });

    const upserts = callsTo("eval_run_results", "upsert");
    expect(upserts).toHaveLength(2);
    // 20 rows × 2 criteria in the first checkpoint, the remaining row in the second.
    expect(upserts[0].args[0]).toHaveLength(40);
    expect(upserts[1].args[0]).toHaveLength(2);
  });
});

// --- coverage-gap fill: branches not otherwise exercised above ---

describe("AGENT_FANOUT_CONCURRENCY module-load fallback", () => {
  it("falls back to 5 for an unparseable EVAL_AGENT_FANOUT_CONCURRENCY", async () => {
    vi.stubEnv("EVAL_AGENT_FANOUT_CONCURRENCY", "not-a-number");
    vi.resetModules();
    const { prepareEvalRun: freshPrepare } = await import("./activities.js");
    db.results = [
      runRow(),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: [{ row_index: 0 }], error: null },
    ];
    const prep = await freshPrepare(RUN_ID);
    expect(prep).toMatchObject({ agentFanoutConcurrency: 5 });
    vi.unstubAllEnvs();
  });

  it("falls back to 5 for a non-positive EVAL_AGENT_FANOUT_CONCURRENCY", async () => {
    vi.stubEnv("EVAL_AGENT_FANOUT_CONCURRENCY", "-3");
    vi.resetModules();
    const { prepareEvalRun: freshPrepare } = await import("./activities.js");
    db.results = [
      runRow(),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: [{ row_index: 0 }], error: null },
    ];
    const prep = await freshPrepare(RUN_ID);
    expect(prep).toMatchObject({ agentFanoutConcurrency: 5 });
    vi.unstubAllEnvs();
  });
});

describe("prepareEvalRun: claim + paged-read error branches", () => {
  it("throws when the queued→running claim update fails", async () => {
    db.results = [runRow(), orgRow, { data: null, error: { message: "claim blew up" } }];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow("Failed to claim eval run: claim blew up");
  });

  it("throws terminal when the claim matches no row (run already in a terminal state)", async () => {
    db.results = [runRow(), orgRow, { data: null, error: null }];
    const thrown = await prepareEvalRun(RUN_ID).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toBe("Eval run is already in a terminal state");
  });

  it("throws when the paged row-index read fails", async () => {
    db.results = [
      runRow(),
      { data: { id: "rubric-1" }, error: null },
      { data: { id: RUN_ID }, error: null },
      { data: null, error: { message: "rows blew up" } },
    ];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow("Failed to load rows: rows blew up");
  });
});

describe("loadAgentRunContext branches (via invokeAgentRow)", () => {
  const inputRow = (rowIndex: number) => ({
    data: {
      row_index: rowIndex,
      user_input: `q${rowIndex}`,
      agent_output: "",
      expected_output: null,
      retrieval_context: null,
    },
    error: null,
  });

  it("throws terminal when the run has no schedule to invoke against", async () => {
    const runId = "run-no-schedule";
    db.results = [inputRow(0), runRow({ id: runId, schedule_id: null })];
    const thrown = await invokeAgentRow({ evalRunId: runId, rowIndex: 0 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toBe("Eval run has no schedule — nothing to invoke");
  });

  it("throws terminal when the schedule's Connection is not an agent", async () => {
    const runId = "run-not-agent";
    db.results = [
      inputRow(0),
      runRow({ id: runId, schedule_id: "sched-1" }),
      orgRow,
      { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
      { data: { id: "conn-1", kind: "dataset", provider: "custom", auth_secret_id: null }, error: null },
    ];
    const thrown = await invokeAgentRow({ evalRunId: runId, rowIndex: 0 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toBe("Eval run's Connection is not an agent");
  });

  const managedContextQueries = (runId: string, targetModel: unknown) => [
    inputRow(0),
    runRow({ id: runId, schedule_id: "sched-1" }),
    orgRow,
    { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
    {
      data: {
        id: "conn-1",
        kind: "agent",
        provider: "anthropic",
        auth_secret_id: null,
        agent_kind: "managed",
        target_model: targetModel,
        optimizable_prompts: [{ name: "system", seed: "Be helpful." }],
      },
      error: null,
    },
  ];

  it("throws terminal when a Managed Agent has no usable target_model", async () => {
    const runId = "run-no-target-model";
    db.results = managedContextQueries(runId, null);
    const thrown = await invokeAgentRow({ evalRunId: runId, rowIndex: 0 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toMatch(/invalid or missing target_model/);
  });

  it("throws terminal when a Managed Agent's target_model isn't an Anthropic model", async () => {
    const runId = "run-bad-target-model";
    db.results = managedContextQueries(runId, "gpt-5");
    const thrown = await invokeAgentRow({ evalRunId: runId, rowIndex: 0 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toMatch(/invalid or missing target_model: gpt-5/);
  });

  it("throws terminal when the Managed Agent's target key resolves to none", async () => {
    const runId = "run-target-no-key";
    mockResolveProviderKey.mockResolvedValue({ source: "none" });
    db.results = managedContextQueries(runId, PRICED_JUDGE_MODEL);
    const thrown = await invokeAgentRow({ evalRunId: runId, rowIndex: 0 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
  });

});

describe("invokeAgentRow: row-load and persistence error branches", () => {
  it("throws when the row read itself fails", async () => {
    db.results = [{ data: null, error: { message: "row read blew up" } }];
    await expect(invokeAgentRow({ evalRunId: "run-x", rowIndex: 0 })).rejects.toThrow(
      "Failed to load row 0: row read blew up"
    );
  });

  it("throws terminal when the input row does not exist", async () => {
    db.results = [{ data: null, error: null }];
    const thrown = await invokeAgentRow({ evalRunId: "run-x", rowIndex: 0 }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toBe("Input row 0 not found");
  });

  it("throws when persisting an external agent's output fails", async () => {
    const runId = "run-persist-fail";
    db.results = [
      { data: { row_index: 0, user_input: "q0", agent_output: "", expected_output: null, retrieval_context: null }, error: null },
      runRow({ id: runId, schedule_id: "sched-1" }),
      orgRow,
      { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
      {
        data: { id: "conn-1", kind: "agent", provider: "custom", auth_secret_id: null, agent_kind: "external", target_model: null },
        error: null,
      },
      { data: null, error: { message: "persist blew up" } },
    ];
    mockInvokeAgent.mockResolvedValue("live answer");
    await expect(invokeAgentRow({ evalRunId: runId, rowIndex: 0 })).rejects.toThrow(
      "Failed to persist agent output: persist blew up"
    );
  });

});

describe("judgeEvalRun: no-rows terminal branch", () => {
  it("throws terminal when the run has no input rows to judge", async () => {
    db.results = [runRow(), orgRow, rubricRow, { data: [], error: null }];
    const thrown = await judgeEvalRun({ evalRunId: RUN_ID }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toBe("No input rows found");
  });

  it("throws terminal (via loadRubric) when the rubric disappears between the org lookup and the full load", async () => {
    db.results = [runRow(), orgRow, { data: null, error: null }];
    const thrown = await judgeEvalRun({ evalRunId: RUN_ID }).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toBe("Rubric not found");
  });

  it("throws when the rubric read itself fails", async () => {
    db.results = [runRow(), orgRow, { data: null, error: { message: "rubric read blew up" } }];
    await expect(judgeEvalRun({ evalRunId: RUN_ID })).rejects.toThrow(
      "Failed to load rubric: rubric read blew up"
    );
  });
});

describe("terminal-write error branches", () => {
  it("completeEvalRun throws when the completion update itself fails", async () => {
    db.results = [{ data: null, error: { message: "complete update blew up" } }];
    await expect(
      completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.5, rowCount: 1 })
    ).rejects.toThrow("Failed to complete eval run: complete update blew up");
  });

});

describe("loadEvalRun / loadOrgId error branches", () => {
  it("throws terminal when the eval run itself does not exist", async () => {
    db.results = [{ data: null, error: null }];
    const thrown = await prepareEvalRun(RUN_ID).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toBe("Eval run not found");
  });

  it("throws when loading the eval run fails", async () => {
    db.results = [{ data: null, error: { message: "run read blew up" } }];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow("Failed to load eval run: run read blew up");
  });

  it("throws when loading the owning org fails", async () => {
    db.results = [runRow(), { data: null, error: { message: "org read blew up" } }];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow("Failed to load rubric org: org read blew up");
  });
});

describe("loadScheduleConnection error branches (via prepareEvalRun)", () => {
  const claimedSeq = () => [runRow({ schedule_id: "sched-1" }), orgRow, { data: { id: RUN_ID }, error: null }];

  it("throws when the schedule read fails", async () => {
    db.results = [...claimedSeq(), { data: null, error: { message: "schedule read blew up" } }];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow("Failed to load schedule: schedule read blew up");
  });

  it("throws terminal when the schedule does not exist", async () => {
    db.results = [...claimedSeq(), { data: null, error: null }];
    const thrown = await prepareEvalRun(RUN_ID).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toBe("Schedule not found for run");
  });

  it("throws when the connection read fails", async () => {
    db.results = [
      ...claimedSeq(),
      { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
      { data: null, error: { message: "connection read blew up" } },
    ];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow(
      "Failed to load connection: connection read blew up"
    );
  });

  it("throws terminal when the connection does not exist", async () => {
    db.results = [
      ...claimedSeq(),
      { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
      { data: null, error: null },
    ];
    const thrown = await prepareEvalRun(RUN_ID).catch((e) => e);
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).message).toBe("Connection not found for schedule");
  });
});

describe("getAuthValue error branch (via invokeAgentRow)", () => {
  it("throws when decrypting the Connection credential fails", async () => {
    const runId = "run-auth-fail";
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: "vault decrypt failed" } });
    db.results = [
      { data: { row_index: 0, user_input: "q0", agent_output: "", expected_output: null, retrieval_context: null }, error: null },
      runRow({ id: runId, schedule_id: "sched-1" }),
      orgRow,
      { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
      {
        data: { id: "conn-1", kind: "agent", provider: "custom", auth_secret_id: "sec-1", agent_kind: "external", target_model: null },
        error: null,
      },
    ];
    await expect(invokeAgentRow({ evalRunId: runId, rowIndex: 0 })).rejects.toThrow(
      "Failed to read Connection credential: vault decrypt failed"
    );
  });
});

describe("resolveDatasetRows branches (via prepareEvalRun)", () => {
  const claimedDatasetSeq = () => [
    runRow({ schedule_id: "sched-1" }),
    orgRow,
    { data: { id: RUN_ID }, error: null },
    { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
    { data: { id: "conn-1", kind: "dataset", provider: "custom", auth_secret_id: null }, error: null },
  ];

  it("throws when the existing-rows count read fails", async () => {
    db.results = [...claimedDatasetSeq(), { count: null, error: { message: "count blew up" } }];
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow("Failed to count rows: count blew up");
  });

  it("defaults window_minutes to 60 and max_rows to 100 when the schedule leaves them unset", async () => {
    db.results = [
      ...claimedDatasetSeq(),
      { count: 0, error: null },
      { data: null, error: null }, // rows upsert
      { data: [{ row_index: 0 }], error: null },
    ];
    mockAdapter.mockResolvedValue([
      { user_input: "q0", agent_output: "a0", expected_output: null, retrieval_context: null },
    ]);
    const prep = await prepareEvalRun(RUN_ID);
    expect(prep).toMatchObject({ outcome: READY });
    expect(mockAdapter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxRows: 100 })
    );
  });

  it("throws when persisting the fetched dataset rows fails", async () => {
    db.results = [
      ...claimedDatasetSeq(),
      { count: 0, error: null },
      { data: null, error: { message: "fetched-rows upsert blew up" } },
    ];
    mockAdapter.mockResolvedValue([
      { user_input: "q0", agent_output: "a0", expected_output: null, retrieval_context: null },
    ]);
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow(
      "Failed to save fetched rows: fetched-rows upsert blew up"
    );
  });
});

describe("markSkipped error branch", () => {
  it("throws when the skipped-status update fails", async () => {
    db.results = [
      runRow({ schedule_id: "sched-1" }),
      orgRow,
      { data: { id: RUN_ID }, error: null },
      { data: { connection_id: "conn-1", window_minutes: 60, max_rows: 100 }, error: null },
      { data: { id: "conn-1", kind: "dataset", provider: "custom", auth_secret_id: null }, error: null },
      { count: 0, error: null },
      { data: null, error: { message: "skip update blew up" } },
    ];
    mockAdapter.mockResolvedValue([]);
    await expect(prepareEvalRun(RUN_ID)).rejects.toThrow(
      "Failed to mark eval run skipped: skip update blew up"
    );
  });
});

describe("failRunQuietly (exported for the orphaned-workflow sweep)", () => {
  it("performs the transition and returns true", async () => {
    db.results = [{ data: { id: RUN_ID }, error: null }];
    const performed = await failRunQuietly(RUN_ID, "orphaned workflow reaped");
    expect(performed).toBe(true);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("returns false when another attempt already transitioned it", async () => {
    db.results = [{ data: null, error: null }]; // guarded update: no match
    const performed = await failRunQuietly(RUN_ID, "irrelevant — already terminal");
    expect(performed).toBe(false);
  });

  it("throws when the failed-transition write itself fails", async () => {
    db.results = [{ data: null, error: { message: "write blew up" } }];
    await expect(failRunQuietly(RUN_ID, "msg")).rejects.toThrow(
      "Failed to mark eval run failed: write blew up"
    );
  });
});

describe("loadRunNotification branches", () => {
  it("swallows a missing notification row (best-effort) without throwing or emailing", async () => {
    db.results = [
      { data: { id: RUN_ID }, error: null }, // guarded completion update
      { data: null, error: null }, // loadRunNotification: run not found
    ];
    await expect(
      completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.5, rowCount: 1 })
    ).resolves.toBeUndefined();
    expect(mockSendCompletion).not.toHaveBeenCalled();
  });

  it("unwraps a PostgREST array-shaped rubrics embed (not just the single-object shape)", async () => {
    db.results = [
      { data: { id: RUN_ID }, error: null },
      {
        data: { notification_emails: ["ops@example.com"], rubrics: [{ name: "Array-shaped rubric" }] },
        error: null,
      },
    ];
    await completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.5, rowCount: 1 });
    expect(mockSendCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ rubricName: "Array-shaped rubric" })
    );
  });
});
