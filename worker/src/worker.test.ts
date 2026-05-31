import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { evaluateRun } from "./evaluator.js";
import { sendCompletionEmail, sendFailureEmail } from "./emailer.js";

// --- Mocks ---

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("http", () => ({
  createServer: () => ({ listen: vi.fn() }),
}));

vi.mock("./providers/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("./evaluator.js", () => ({ evaluateRun: vi.fn() }));
vi.mock("./emailer.js", () => ({ sendCompletionEmail: vi.fn(), sendFailureEmail: vi.fn() }));
vi.mock("./telemetry.js", () => ({
  initTelemetry: vi.fn(),
  trackRunCompleted: vi.fn(),
  captureException: vi.fn(),
}));

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- reapStaleRuns ---

describe("reapStaleRuns", () => {
  it("calls reap_stale_eval_runs RPC with the configured threshold", async () => {
    mockRpc.mockResolvedValue({ data: 0, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(mockRpc).toHaveBeenCalledWith("reap_stale_eval_runs", {
      p_threshold_minutes: 10,
    });
  });

  it("logs the count when runs are reaped", async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(console.log).toHaveBeenCalledWith("Reaped 3 stale run(s)");
  });

  it("does not log when no runs are reaped", async () => {
    mockRpc.mockResolvedValue({ data: 0, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs error and does not throw when RPC fails", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { reapStaleRuns } = await import("./worker.js");
    await expect(reapStaleRuns()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "Stale run reaper error",
      expect.objectContaining({ message: "db error" })
    );
  });
});

// --- poll ---

describe("poll", () => {
  function makeFromChain(result: unknown) {
    const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), update: vi.fn(), maybeSingle: vi.fn() };
    for (const k of ["select", "eq", "order", "update"] as const) chain[k].mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue(result);
    mockFrom.mockReturnValue(chain);
    return chain;
  }

  it("returns false when queue is empty", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { poll } = await import("./worker.js");
    expect(await poll({} as never)).toBe(false);
  });

  it("returns false on dequeue RPC error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "queue error" } });
    const { poll } = await import("./worker.js");
    expect(await poll({} as never)).toBe(false);
  });

  it("returns true when a message is dequeued and processed", async () => {
    // First rpc call = dequeue, subsequent calls = ack
    mockRpc
      .mockResolvedValueOnce({ data: [{ msg_id: BigInt(1), run_id: "run_abc" }], error: null })
      .mockResolvedValue({ error: null });

    // processMessage fetches run → null so it acks and returns early
    makeFromChain({ data: null, error: { message: "not found" } });

    const { poll } = await import("./worker.js");
    expect(await poll({} as never)).toBe(true);
  });
});

// --- processMessage: scheduled agent runs (resolveScheduledAgentOutputs) ---
//
// Scheduled runs arrive with empty agent_output. Before scoring, the worker must
// invoke the Connection's endpoint live, persist each output, then score. These cover
// the success path plus the failure modes that must mark the run failed — so broken
// scheduling never silently completes or scores empty outputs.

describe("processMessage scheduled agent path", () => {
  const ENDPOINT = "https://agent.example.com/run";
  const mockEvaluateRun = vi.mocked(evaluateRun);
  const mockCompletion = vi.mocked(sendCompletionEmail);
  const mockFailure = vi.mocked(sendFailureEmail);
  let mockFetch: Mock;
  let chain: Record<string, Mock>;

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body };
  }

  // A single chainable stub returned for every from(); reads resolve from the
  // maybeSingle/order queues in the worker's call order. update/insert just return
  // the chain (their awaited results are ignored or destructured to undefined).
  function setupChain() {
    chain = {
      select: vi.fn(), eq: vi.fn(), order: vi.fn(),
      update: vi.fn(), insert: vi.fn(), maybeSingle: vi.fn(),
    };
    for (const k of ["select", "eq", "order", "update", "insert"]) {
      chain[k].mockReturnValue(chain);
    }
    mockFrom.mockReturnValue(chain);
  }

  // Queue the reads for a scheduled run, in call order:
  //   maybeSingle: run → rubric → claim → schedule → connection
  //   order:       rows
  function queueScheduledRun(opts: {
    runId: string;
    emails?: string[];
    authSecretId?: string | null;
    connection?: Record<string, unknown> | null;
    scheduleError?: { message: string };
    connectionError?: { message: string };
  }) {
    const { runId, emails = [], authSecretId = null } = opts;
    const connection =
      opts.connection === undefined
        ? {
            id: "conn_1", kind: "agent", endpoint: ENDPOINT,
            auth_header: authSecretId ? "Authorization" : null,
            auth_secret_id: authSecretId,
            request_template: { input: "{{user_input}}" },
            response_path: "output",
          }
        : opts.connection;

    chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: runId, rubric_id: "rubric_1", notification_emails: emails, eval_type: "tabular", schedule_id: "sched_1" }, error: null })
      .mockResolvedValueOnce({ data: { name: "R", scenario_description: "s", expected_outcome: "o", grounding_context: null, criteria: [{ name: "Accuracy", weight: 1, steps: ["x"] }] }, error: null })
      .mockResolvedValueOnce({ data: { id: runId }, error: null })
      .mockResolvedValueOnce(
        opts.scheduleError
          ? { data: null, error: opts.scheduleError }
          : { data: { connection_id: "conn_1" }, error: null }
      )
      .mockResolvedValueOnce(
        opts.connectionError
          ? { data: null, error: opts.connectionError }
          : { data: connection, error: null }
      );

    chain.order.mockResolvedValueOnce({
      data: [{ row_index: 0, user_input: "ping", agent_output: "", expected_output: null, retrieval_context: null }],
      error: null,
    });

    mockRpc.mockImplementation((fn: string) => {
      if (fn === "dequeue_eval_run_message") return Promise.resolve({ data: [{ msg_id: 1n, run_id: runId }], error: null });
      if (fn === "get_connection_auth") return Promise.resolve({ data: "Bearer s3cr3t", error: null });
      return Promise.resolve({ data: null, error: null });
    });
  }

  beforeEach(() => {
    setupChain();
    // The worker calls `sendCompletionEmail(...).catch(...)`, so the mocks must
    // return a promise (default vi.fn() returns undefined → ".catch of undefined").
    mockCompletion.mockResolvedValue(undefined);
    mockFailure.mockResolvedValue(undefined);
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes the agent, persists live output, scores it, and completes", async () => {
    queueScheduledRun({ runId: "run_ok", emails: ["ops@x.com"] });
    mockFetch.mockResolvedValue(jsonResponse({ output: "live answer" }));
    mockEvaluateRun.mockResolvedValue({
      results: [{ rowIndex: 0, criterionName: "Accuracy", score: 0.9, reasoning: "good" }],
      overallScore: 0.9,
    });

    const { poll } = await import("./worker.js");
    await poll({} as never);

    // Called the agent endpoint once, via POST.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ method: "POST" }));
    // Persisted the live output back onto the row, and scored the FILLED rows.
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ agent_output: "live answer" }));
    expect(mockEvaluateRun).toHaveBeenCalledTimes(1);
    const [, scoredRows, , evalType] = mockEvaluateRun.mock.calls[0];
    expect((scoredRows as Array<{ agent_output: string }>)[0].agent_output).toBe("live answer");
    expect(evalType).toBe("tabular");
    // Completed + completion email, no failure email.
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", overall_score: 0.9 }));
    expect(mockCompletion).toHaveBeenCalled();
    expect(mockFailure).not.toHaveBeenCalled();
  });

  it("sends the decrypted credential in the configured auth header", async () => {
    queueScheduledRun({ runId: "run_auth", authSecretId: "secret_1" });
    mockFetch.mockResolvedValue(jsonResponse({ output: "ok" }));
    mockEvaluateRun.mockResolvedValue({
      results: [{ rowIndex: 0, criterionName: "Accuracy", score: 1, reasoning: "ok" }],
      overallScore: 1,
    });

    const { poll } = await import("./worker.js");
    await poll({} as never);

    const authCall = mockRpc.mock.calls.find((c: unknown[]) => c[0] === "get_connection_auth");
    expect(authCall?.[1]).toEqual({ p_secret_id: "secret_1" });
    const fetchOpts = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchOpts.headers.Authorization).toBe("Bearer s3cr3t");
  });

  it("marks the run failed (no scoring) when the agent endpoint errors", async () => {
    queueScheduledRun({ runId: "run_http", emails: ["ops@x.com"] });
    mockFetch.mockResolvedValue(jsonResponse({}, false, 500));

    const { poll } = await import("./worker.js");
    await poll({} as never);

    expect(mockEvaluateRun).not.toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: expect.stringContaining("500") }));
    expect(chain.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(mockFailure).toHaveBeenCalledWith(expect.objectContaining({ to: ["ops@x.com"] }));
  });

  it("marks the run failed when the Connection is missing", async () => {
    queueScheduledRun({ runId: "run_noconn", emails: ["ops@x.com"], connection: null });

    const { poll } = await import("./worker.js");
    await poll({} as never);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEvaluateRun).not.toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: expect.stringContaining("Connection") }));
    expect(mockFailure).toHaveBeenCalled();
  });

  it("surfaces the underlying DB error when the schedule lookup fails", async () => {
    queueScheduledRun({ runId: "run_scherr", emails: ["ops@x.com"], scheduleError: { message: "permission denied" } });

    const { poll } = await import("./worker.js");
    await poll({} as never);

    // Real DB failure must surface, not the misleading "not found".
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEvaluateRun).not.toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error_message: expect.stringContaining("permission denied") }),
    );
    expect(chain.update).not.toHaveBeenCalledWith(expect.objectContaining({ error_message: "Schedule not found for run" }));
    expect(mockFailure).toHaveBeenCalled();
  });

  it("surfaces the underlying DB error when the connection lookup fails", async () => {
    queueScheduledRun({ runId: "run_connerr", emails: ["ops@x.com"], connectionError: { message: "statement timeout" } });

    const { poll } = await import("./worker.js");
    await poll({} as never);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEvaluateRun).not.toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error_message: expect.stringContaining("statement timeout") }),
    );
    expect(mockFailure).toHaveBeenCalled();
  });
});
