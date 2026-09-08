import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/common";
import { captureException } from "./telemetry.js";

// --- Mocks ---
// worker.ts is now a thin DISPATCHER (#123): it starts the durable `runEvalWorkflow` for a
// dequeued scheduled run and acks the pgmq message. All eval execution + billing lives in the
// workflow's Activities (evalrun/activities.ts, covered in activities.test.ts). These tests
// exercise the dispatch decisions (start / skip-terminal / idempotent-redelivery / retry) and
// the reapers.
//
// The Activities read/write Postgres through one supabase client. The stub hands every query
// chain back a recording builder; awaiting a chain consumes the next queued result in order.

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
      for (const method of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit", "range", "not", "lt"]) {
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

vi.mock("http", () => ({ createServer: () => ({ listen: vi.fn() }) }));

const { mockWorkflowStart, mockDescribe } = vi.hoisted(() => ({
  mockWorkflowStart: vi.fn(),
  mockDescribe: vi.fn(),
}));
vi.mock("./temporal/client.js", () => ({
  getTemporalClient: async () => ({
    workflow: { start: mockWorkflowStart, getHandle: () => ({ describe: mockDescribe }) },
  }),
}));
// The Temporal worker registration is only touched by main(); stub it so importing worker.js
// never dials a real Temporal server.
vi.mock("./temporal/worker.js", () => ({ startTemporalWorker: vi.fn().mockResolvedValue({}) }));

vi.mock("./telemetry.js", () => ({
  initTelemetry: vi.fn(),
  trackRunCompleted: vi.fn(),
  captureException: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.results = [];
  db.calls = [];
  db.rpc.mockResolvedValue({ data: null, error: null });
  mockWorkflowStart.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function callsTo(table: string, method: string): RecordedCall[] {
  return db.calls.filter((c) => c.table === table && c.method === method);
}

const MSG_ID = 42n;
const RUN_ID = "run-1";

// --- dispatchEvalRun ---

describe("dispatchEvalRun", () => {
  it("stamps workflow_id, starts runEvalWorkflow, and acks the message", async () => {
    db.results = [
      { data: { id: RUN_ID, status: "queued", workflow_id: null }, error: null }, // status read
      { data: null, error: null }, // workflow_id stamp
    ];
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    const stamp = callsTo("eval_runs", "update")[0];
    expect(stamp.args[0]).toEqual({ workflow_id: `eval-${RUN_ID}` });
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "runEvalWorkflow",
      expect.objectContaining({ workflowId: `eval-${RUN_ID}`, args: [{ evalRunId: RUN_ID }] })
    );
    expect(db.rpc).toHaveBeenCalledWith("ack_eval_run_message", { p_msg_id: MSG_ID });
  });

  it("does NOT re-dispatch an already-terminal run — just acks the redelivered message", async () => {
    db.results = [{ data: { id: RUN_ID, status: "completed", workflow_id: `eval-${RUN_ID}` }, error: null }];
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith("ack_eval_run_message", { p_msg_id: MSG_ID });
  });

  it("treats an already-started workflow as the idempotent happy path (acks, no error)", async () => {
    db.results = [{ data: { id: RUN_ID, status: "queued", workflow_id: `eval-${RUN_ID}` }, error: null }];
    mockWorkflowStart.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError("already started", `eval-${RUN_ID}`, "runEvalWorkflow")
    );
    const { dispatchEvalRun } = await import("./worker.js");

    await expect(dispatchEvalRun(MSG_ID, RUN_ID)).resolves.toBeUndefined();
    expect(db.rpc).toHaveBeenCalledWith("ack_eval_run_message", { p_msg_id: MSG_ID });
  });

  it("does NOT ack (leaves the message for redelivery) when the workflow start fails", async () => {
    db.results = [
      { data: { id: RUN_ID, status: "queued", workflow_id: `eval-${RUN_ID}` }, error: null },
    ];
    mockWorkflowStart.mockRejectedValue(new Error("Temporal unreachable"));
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    expect(db.rpc).not.toHaveBeenCalledWith("ack_eval_run_message", { p_msg_id: MSG_ID });
  });

  it("acks and skips when the run row is gone (rolled back at creation)", async () => {
    db.results = [{ data: null, error: null }];
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith("ack_eval_run_message", { p_msg_id: MSG_ID });
  });

  it("does NOT ack on a transient fetch error (retries on the next poll)", async () => {
    db.results = [{ data: null, error: { message: "connection reset" } }];
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("does NOT ack (leaves the message for redelivery) when stamping workflow_id fails", async () => {
    db.results = [
      { data: { id: RUN_ID, status: "queued", workflow_id: null }, error: null }, // status read
      { data: null, error: { message: "row locked" } }, // workflow_id stamp fails
    ];
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    expect(mockWorkflowStart).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("ack_eval_run_message", expect.anything());
    expect(console.error).toHaveBeenCalledWith(
      "Failed to stamp workflow_id — message will be redelivered",
      expect.objectContaining({ event: "eval_run.dispatch_stamp_failed", run_id: RUN_ID }),
    );
  });

  it("logs when acking a message fails", async () => {
    db.results = [{ data: { id: RUN_ID, status: "completed", workflow_id: `eval-${RUN_ID}` }, error: null }];
    db.rpc.mockResolvedValue({ error: { message: "ack failed" } });
    const { dispatchEvalRun } = await import("./worker.js");

    await dispatchEvalRun(MSG_ID, RUN_ID);

    expect(console.error).toHaveBeenCalledWith(
      "Failed to ack eval run message — message may be redelivered",
      expect.objectContaining({ event: "eval_run.ack_failed", run_id: RUN_ID, msg_id: String(MSG_ID) }),
    );
  });
});

// --- poll ---

describe("poll", () => {
  it("returns false when the queue is empty", async () => {
    db.rpc.mockResolvedValueOnce({ data: [], error: null }); // dequeue
    const { poll } = await import("./worker.js");
    expect(await poll()).toBe(false);
  });

  it("dequeues a message and dispatches its run", async () => {
    db.rpc
      .mockResolvedValueOnce({ data: [{ msg_id: MSG_ID, run_id: RUN_ID }], error: null }) // dequeue
      .mockResolvedValue({ data: null, error: null }); // ack + any other rpc
    db.results = [
      { data: { rubrics: { org_id: "org-1" } }, error: null }, // org correlation
      { data: { id: RUN_ID, status: "queued", workflow_id: null }, error: null }, // dispatch status
      { data: null, error: null }, // stamp
    ];
    const { poll } = await import("./worker.js");

    expect(await poll()).toBe(true);
    expect(mockWorkflowStart).toHaveBeenCalledWith(
      "runEvalWorkflow",
      expect.objectContaining({ args: [{ evalRunId: RUN_ID }] })
    );
  });

  it("returns false and does not throw on a dequeue error", async () => {
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: "db error" } });
    const { poll } = await import("./worker.js");
    expect(await poll()).toBe(false);
  });
});

// --- reapStaleRuns (inert safety net) ---

describe("reapStaleRuns", () => {
  it("calls reap_stale_eval_runs RPC with the configured threshold", async () => {
    db.rpc.mockResolvedValue({ data: 0, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(db.rpc).toHaveBeenCalledWith("reap_stale_eval_runs", { p_threshold_minutes: 10 });
  });

  it("logs the count when runs are reaped", async () => {
    db.rpc.mockResolvedValue({ data: 3, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(console.log).toHaveBeenCalledWith(
      "Reaped stale eval run(s)",
      expect.objectContaining({ event: "eval_run.reaped", count: 3 })
    );
  });

  it("logs error and does not throw when RPC fails", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { reapStaleRuns } = await import("./worker.js");
    await expect(reapStaleRuns()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "Stale run reaper error",
      expect.objectContaining({ event: "eval_run.reap_failed" })
    );
  });
});

// --- reapStaleOptimizationRuns (#90) ---

describe("reapStaleOptimizationRuns", () => {
  it("calls reap_stale_optimization_runs RPC with the configured threshold", async () => {
    db.rpc.mockResolvedValue({ data: 0, error: null });
    const { reapStaleOptimizationRuns } = await import("./worker.js");
    await reapStaleOptimizationRuns();
    expect(db.rpc).toHaveBeenCalledWith("reap_stale_optimization_runs", { p_threshold_minutes: 30 });
  });

  it("logs the count when optimization runs are reaped", async () => {
    db.rpc.mockResolvedValue({ data: 2, error: null });
    const { reapStaleOptimizationRuns } = await import("./worker.js");
    await reapStaleOptimizationRuns();
    expect(console.log).toHaveBeenCalledWith(
      "Reaped stale optimization run(s)",
      expect.objectContaining({ event: "optimization_run.reaped", count: 2 })
    );
  });

  it("logs error and does not throw when RPC fails", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { reapStaleOptimizationRuns } = await import("./worker.js");
    await expect(reapStaleOptimizationRuns()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "Stale optimization run reaper error",
      expect.objectContaining({ event: "optimization_run.reap_failed" })
    );
  });
});

// --- reapOrphanedWorkflowRuns (review fix: recovery for workflow-stamped strays) ---

describe("reapOrphanedWorkflowRuns", () => {
  const staleRun = (status: "queued" | "running") => ({
    data: [{ id: RUN_ID, status, workflow_id: `eval-${RUN_ID}` }],
    error: null,
  });

  it("reaps a running run whose workflow finished without a terminal status", async () => {
    db.results = [
      staleRun("running"),
      { data: { id: RUN_ID }, error: null }, // failRunQuietly's guarded transition
    ];
    mockDescribe.mockResolvedValue({ status: { name: "FAILED" } });

    const { reapOrphanedWorkflowRuns } = await import("./worker.js");
    await reapOrphanedWorkflowRuns();

    const update = callsTo("eval_runs", "update")[0];
    expect(update.args[0]).toMatchObject({
      status: "failed",
      error_message: "Workflow ended without a terminal status",
    });
    // Settlement fires so the reaped run's reservations unpin.
  });

  it("logs and captures (without throwing into the sweep) when reaping a run fails", async () => {
    db.results = [
      staleRun("running"),
      { data: null, error: { message: "row locked" } }, // failRunQuietly's update fails
    ];
    mockDescribe.mockResolvedValue({ status: { name: "FAILED" } });

    const { reapOrphanedWorkflowRuns } = await import("./worker.js");
    await expect(reapOrphanedWorkflowRuns()).resolves.toBeUndefined();

    const { captureException } = await import("./telemetry.js");
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: "reapOrphanedWorkflowRuns", run_id: RUN_ID }),
    );
    expect(console.error).toHaveBeenCalledWith(
      "Failed to reap orphaned workflow run",
      expect.objectContaining({ event: "eval_run.orphan_reap_failed", run_id: RUN_ID }),
    );
  });

  it("reaps a stamped-but-never-started run (workflow not found)", async () => {
    db.results = [staleRun("queued"), { data: { id: RUN_ID }, error: null }];
    mockDescribe.mockRejectedValue(
      new WorkflowNotFoundError("no such workflow", `eval-${RUN_ID}`, undefined)
    );

    const { reapOrphanedWorkflowRuns } = await import("./worker.js");
    await reapOrphanedWorkflowRuns();

    const update = callsTo("eval_runs", "update")[0];
    expect(update.args[0]).toMatchObject({
      status: "failed",
      error_message: "Workflow never started",
    });
  });

  it("leaves a run with a LIVE workflow untouched — liveness, not the stamp, decides", async () => {
    db.results = [staleRun("running")];
    mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });

    const { reapOrphanedWorkflowRuns } = await import("./worker.js");
    await reapOrphanedWorkflowRuns();

    expect(callsTo("eval_runs", "update")).toHaveLength(0);
    expect(db.rpc).not.toHaveBeenCalledWith("settle_eval_run_points", expect.anything());
  });

  it("skips the run when liveness is UNKNOWN (describe failed transiently)", async () => {
    db.results = [staleRun("running")];
    mockDescribe.mockRejectedValue(new Error("temporal unreachable"));

    const { reapOrphanedWorkflowRuns } = await import("./worker.js");
    await reapOrphanedWorkflowRuns();

    // Reaping a possibly-live workflow's run is worse than sweeping it up next tick.
    expect(callsTo("eval_runs", "update")).toHaveLength(0);
  });

  it("logs and returns when the sweep query fails — never throws into the poll loop", async () => {
    db.results = [{ data: null, error: { message: "boom" } }];
    const { reapOrphanedWorkflowRuns } = await import("./worker.js");
    await expect(reapOrphanedWorkflowRuns()).resolves.toBeUndefined();
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});

// --- reportFatalError ---
//
// registerProcessErrorHandlers and main() are NOT exported (main isn't called under
// `process.env.VITEST`, and the process.on("uncaughtException"/"unhandledRejection") wiring
// lives only inside the unexported registerProcessErrorHandlers). reportFatalError IS exported
// and is the one piece of that crash-handling path this suite can drive directly — see the
// final report for why the rest is untestable without changing production source.

describe("reportFatalError", () => {
  it("captures an uncaughtException and logs a structured error record", async () => {
    const { reportFatalError } = await import("./worker.js");
    const err = new Error("segfault-ish");

    reportFatalError("uncaughtException", err);

    expect(captureException).toHaveBeenCalledWith(err, { context: "uncaughtException" });
    expect(console.error).toHaveBeenCalledWith(
      "Uncaught exception",
      expect.objectContaining({ event: "worker.uncaught_exception", error: err }),
    );
  });

  it("captures an unhandledRejection and logs a structured error record", async () => {
    const { reportFatalError } = await import("./worker.js");
    const reason = "rejected for no good reason";

    reportFatalError("unhandledRejection", reason);

    expect(captureException).toHaveBeenCalledWith(reason, { context: "unhandledRejection" });
    expect(console.error).toHaveBeenCalledWith(
      "Unhandled promise rejection",
      expect.objectContaining({ event: "worker.unhandled_rejection", error: reason }),
    );
  });

  it("still logs even when the crash-reporter itself throws", async () => {
    vi.mocked(captureException).mockImplementationOnce(() => {
      throw new Error("telemetry is also down");
    });
    const { reportFatalError } = await import("./worker.js");

    expect(() => reportFatalError("uncaughtException", new Error("original crash"))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      "Uncaught exception",
      expect.objectContaining({ event: "worker.uncaught_exception" }),
    );
  });
});
