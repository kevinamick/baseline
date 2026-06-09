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

const { mockJudge, mockInvokeAgent, mockAdapter, mockSendCompletion, mockSendFailure, mockTrack } =
  vi.hoisted(() => ({
    mockJudge: vi.fn(),
    mockInvokeAgent: vi.fn(),
    mockAdapter: vi.fn(),
    mockSendCompletion: vi.fn(),
    mockSendFailure: vi.fn(),
    mockTrack: vi.fn(),
  }));

vi.mock("../providers/anthropic.js", () => ({
  AnthropicProvider: class {
    judge = mockJudge;
  },
}));
vi.mock("../agent.js", () => ({ invokeAgent: mockInvokeAgent }));
vi.mock("../adapters/index.js", () => ({ getDatasetAdapter: () => mockAdapter }));
vi.mock("../emailer.js", () => ({
  sendCompletionEmail: mockSendCompletion,
  sendFailureEmail: mockSendFailure,
}));
vi.mock("../telemetry.js", () => ({ trackRunCompleted: mockTrack }));

import {
  prepareEvalRun,
  invokeAgentRow,
  judgeEvalRun,
  completeEvalRun,
  failEvalRun,
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
});

function callsTo(table: string, method: string): RecordedCall[] {
  return db.calls.filter((c) => c.table === table && c.method === method);
}

// --- prepareEvalRun ---

describe("prepareEvalRun", () => {
  it("manual run: claims queued→running and returns its row indexes", async () => {
    db.results = [
      runRow(), // load run
      { data: { id: "rubric-1" }, error: null }, // rubric exists
      { data: { id: RUN_ID }, error: null }, // claim
      { data: [{ row_index: 0 }, { row_index: 1 }], error: null }, // row indexes
    ];

    const prep = await prepareEvalRun(RUN_ID);

    expect(prep).toEqual({ outcome: READY, kind: MANUAL_KIND, rowIndexes: [0, 1] });
    const claim = callsTo("eval_runs", "update")[0];
    expect(claim.args[0]).toMatchObject({ status: "running" });
    const inCall = callsTo("eval_runs", "in")[0];
    expect(inCall.args).toEqual(["status", ["queued", "running"]]);
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
    expect(prep).toEqual({ outcome: READY, kind: AGENT_KIND, rowIndexes: [0] });
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

    expect(prep).toEqual({ outcome: READY, kind: DATASET_KIND, rowIndexes: [0, 1] });
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
      { data: null, error: null }, // skipped status update
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
  const agentQueries = (agentOutput: string) => [
    runRow({ schedule_id: "sched-1" }),
    { data: { connection_id: "conn-1", window_minutes: null, max_rows: null }, error: null },
    { data: { id: "conn-1", kind: "agent", provider: "custom", auth_secret_id: null }, error: null },
    {
      data: {
        row_index: 0,
        user_input: "q0",
        agent_output: agentOutput,
        expected_output: null,
        retrieval_context: null,
      },
      error: null,
    },
  ];

  it("invokes the agent Connection live and persists the output on the row", async () => {
    db.results = [...agentQueries(""), { data: null, error: null } /* output update */];
    mockInvokeAgent.mockResolvedValue("live answer");

    await invokeAgentRow({ evalRunId: RUN_ID, rowIndex: 0 });

    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn-1", kind: "agent" }),
      expect.objectContaining({ row_index: 0, user_input: "q0" }),
      null
    );
    const update = callsTo("eval_run_rows", "update")[0];
    expect(update.args[0]).toEqual({ agent_output: "live answer" });
  });

  it("skips a row whose output is already persisted (idempotent retry)", async () => {
    db.results = agentQueries("already filled");

    await invokeAgentRow({ evalRunId: RUN_ID, rowIndex: 0 });

    expect(mockInvokeAgent).not.toHaveBeenCalled();
    expect(callsTo("eval_run_rows", "update")).toEqual([]);
  });
});

// --- judgeEvalRun ---

describe("judgeEvalRun", () => {
  it("persists per-criterion scores and reasoning, returning the weighted overall score", async () => {
    db.results = [
      runRow(),
      rubricRow,
      dataRows,
      { data: null, error: null }, // results upsert
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

    const upsert = callsTo("eval_run_results", "upsert")[0];
    expect(upsert.args[0]).toEqual([
      { eval_run_id: RUN_ID, row_index: 0, criterion_name: "Accuracy", score: 1.0, reasoning: "r0 accurate" },
      { eval_run_id: RUN_ID, row_index: 0, criterion_name: "Tone", score: 0.5, reasoning: "r0 tone ok" },
      { eval_run_id: RUN_ID, row_index: 1, criterion_name: "Accuracy", score: 1.0, reasoning: "r1 accurate" },
      { eval_run_id: RUN_ID, row_index: 1, criterion_name: "Tone", score: 0.5, reasoning: "r1 tone ok" },
    ]);
    // Retry-safe persistence: upsert on the run's unique result key, not a bare insert.
    expect(upsert.args[1]).toEqual({ onConflict: "eval_run_id,row_index,criterion_name" });
  });

  it("fails when persisting results fails (the run must not complete without results)", async () => {
    db.results = [
      runRow(),
      rubricRow,
      dataRows,
      { data: null, error: { message: "disk full" } },
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
      { data: null, error: null }, // status update
      { data: { notification_emails: ["ops@example.com"], rubrics: { name: "Support quality" } }, error: null },
    ];

    await completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 });

    const update = callsTo("eval_runs", "update")[0];
    expect(update.args[0]).toMatchObject({ status: "completed", overall_score: 0.8 });
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

  it("does not email when the run has no recipients, and never throws on email failure", async () => {
    db.results = [
      { data: null, error: null },
      { data: { notification_emails: [], rubrics: { name: "Support quality" } }, error: null },
    ];
    await completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 });
    expect(mockSendCompletion).not.toHaveBeenCalled();

    db.results = [
      { data: null, error: null },
      { data: { notification_emails: ["ops@example.com"], rubrics: { name: "R" } }, error: null },
    ];
    mockSendCompletion.mockRejectedValue(new Error("smtp down"));
    await expect(
      completeEvalRun({ evalRunId: RUN_ID, overallScore: 0.8, rowCount: 2 })
    ).resolves.toBeUndefined();
  });
});

describe("failEvalRun", () => {
  it("marks the run failed with the clear reason and sends the failure email", async () => {
    db.results = [
      { data: null, error: null }, // status update
      { data: { notification_emails: ["ops@example.com"], rubrics: { name: "Support quality" } }, error: null },
    ];

    await failEvalRun({ evalRunId: RUN_ID, message: "Agent endpoint returned HTTP 500" });

    const update = callsTo("eval_runs", "update")[0];
    expect(update.args[0]).toMatchObject({
      status: "failed",
      error_message: "Agent endpoint returned HTTP 500",
    });
    expect(mockSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["ops@example.com"],
        runId: RUN_ID,
        rubricName: "Support quality",
        errorMessage: "Agent endpoint returned HTTP 500",
      })
    );
  });

  it("still records the failure when the notification lookup blows up", async () => {
    db.results = [
      { data: null, error: null },
      { data: null, error: { message: "join failed" } },
    ];

    await expect(
      failEvalRun({ evalRunId: RUN_ID, message: "boom" })
    ).resolves.toBeUndefined();
    expect(mockSendFailure).not.toHaveBeenCalled();
  });
});
