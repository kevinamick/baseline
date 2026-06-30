import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
// The notification path touches three things: optimization_runs (status update + created_by /
// connection name read), optimization_inputs (instance count), and auth.admin (starter email).
// We drive each via a thin per-table query stub so the test asserts recipient resolution and
// payload shaping without a real DB.

const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn().mockResolvedValue({ error: null }),
}));

const { state, mockGetUserById } = vi.hoisted(() => ({
  state: {
    runRow: null as unknown,
    runError: null as unknown,
    instanceCount: 0 as number | null,
    instanceCountError: null as unknown,
    // Rows the status UPDATE reports as transitioned — [] simulates a CAS miss (the run
    // already left the expected status, e.g. a cancel landed first).
    updatedRows: [{ id: "run_1" }] as Array<{ id: string }>,
  },
  mockGetUserById: vi.fn(),
}));

// The status writes come in three chain shapes: update().eq() (complete/fail),
// update().eq().eq() awaited (resumeRun's CAS), and update().eq().eq().select() (pauseRun's
// CAS, which reads back the transitioned rows). One self-returning chainable that is also
// thenable covers them all.
function updateChain() {
  const result = { data: state.updatedRows, error: null };
  const chain = {
    eq: () => chain,
    select: () => Promise.resolve(result),
    then: (
      resolve: (value: { data: Array<{ id: string }>; error: null }) => unknown,
      reject?: (reason?: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    // Two shapes are used on this table: the status UPDATE chains (see updateChain) and a
    // select(...).eq().maybeSingle() (the notification read).
    return {
      update: () => updateChain(),
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.runRow, error: state.runError }),
        }),
      }),
    };
  }
  if (table === "optimization_inputs") {
    return {
      select: () => ({
        eq: () =>
          Promise.resolve({ count: state.instanceCount, error: state.instanceCountError }),
      }),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeFrom(table),
    // Allowance + point settlement (#181, ADR-0016) fire on every terminal transition.
    rpc: mockRpc,
    auth: { admin: { getUserById: mockGetUserById } },
  }),
}));

const { mockSendCompletion, mockSendFailure, mockSendPaused } = vi.hoisted(() => ({
  mockSendCompletion: vi.fn(),
  mockSendFailure: vi.fn(),
  mockSendPaused: vi.fn(),
}));

vi.mock("../optimization-emailer.js", () => ({
  sendOptimizationCompletionEmail: mockSendCompletion,
  sendOptimizationFailureEmail: mockSendFailure,
  sendOptimizationPausedEmail: mockSendPaused,
}));

import { completeRun, failRun, pauseRun, loadRunNotification } from "./activities.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.runRow = {
    created_by: "user_1",
    connections: { name: "Support Agent" },
  };
  state.runError = null;
  state.instanceCount = 8;
  state.instanceCountError = null;
  state.updatedRows = [{ id: "run_1" }];
  mockGetUserById.mockResolvedValue({ data: { user: { email: "starter@example.com" } } });
  mockSendCompletion.mockResolvedValue(undefined);
  mockSendFailure.mockResolvedValue(undefined);
  mockSendPaused.mockResolvedValue(undefined);
});

describe("loadRunNotification", () => {
  it("resolves the recipient to the run's created_by user email", async () => {
    const ctx = await loadRunNotification("run_1");
    expect(mockGetUserById).toHaveBeenCalledWith("user_1");
    expect(ctx.email).toBe("starter@example.com");
    expect(ctx.connectionName).toBe("Support Agent");
    expect(ctx.instanceCount).toBe(8);
  });

  it("yields a null recipient (not a throw) when the email can't be resolved", async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null } });
    const ctx = await loadRunNotification("run_1");
    expect(ctx.email).toBeNull();
  });

  it("handles the nested connection arriving as a single-element array", async () => {
    state.runRow = { created_by: "user_1", connections: [{ name: "Array Agent" }] };
    const ctx = await loadRunNotification("run_1");
    expect(ctx.connectionName).toBe("Array Agent");
  });

  it("throws when the optimization_inputs count query fails", async () => {
    state.instanceCountError = { message: "connection refused" };
    await expect(loadRunNotification("run_1")).rejects.toThrow(
      "Failed to count optimization instances: connection refused"
    );
  });
});

describe("completeRun", () => {
  it("emails the starter with connection, score lift, rollouts, instances, and run id", async () => {
    await completeRun({
      optRunId: "run_1",
      bestCandidateId: "cand_9",
      overallScore: 0.81,
      seedScore: 0.62,
      rolloutsUsed: 40,
    });

    expect(mockSendCompletion).toHaveBeenCalledTimes(1);
    const [to, payload] = mockSendCompletion.mock.calls[0];
    expect(to).toBe("starter@example.com");
    expect(payload).toMatchObject({
      runId: "run_1",
      connectionName: "Support Agent",
      seedScore: 0.62,
      bestScore: 0.81,
      rolloutsUsed: 40,
      instanceCount: 8,
    });
  });

  it("does not throw when the email send fails (best-effort)", async () => {
    mockSendCompletion.mockRejectedValue(new Error("resend down"));
    await expect(
      completeRun({
        optRunId: "run_1",
        bestCandidateId: "cand_9",
        overallScore: 0.81,
        seedScore: 0.62,
        rolloutsUsed: 40,
      })
    ).resolves.toBeUndefined();
  });

  it("settles the allowance unit and the point reservation as completed (ADR-0016)", async () => {
    await completeRun({
      optRunId: "run_1",
      bestCandidateId: "cand_9",
      overallScore: 0.81,
      seedScore: 0.62,
      rolloutsUsed: 40,
    });
    expect(mockRpc).toHaveBeenCalledWith("settle_optimization_run", { p_run_id: "run_1" });
    expect(mockRpc).toHaveBeenCalledWith("settle_optimization_run_points", {
      p_run_id: "run_1",
      p_outcome: "completed",
    });
  });

  it("does not throw when the notification context can't be loaded", async () => {
    state.runError = { message: "boom" };
    await expect(
      completeRun({
        optRunId: "run_1",
        bestCandidateId: "cand_9",
        overallScore: 0.81,
        seedScore: 0.62,
        rolloutsUsed: 40,
      })
    ).resolves.toBeUndefined();
    expect(mockSendCompletion).not.toHaveBeenCalled();
  });
});

describe("failRun", () => {
  it("emails the starter with the failure reason and run id", async () => {
    await failRun({ optRunId: "run_1", message: "endpoint unreachable" });

    expect(mockSendFailure).toHaveBeenCalledTimes(1);
    const [to, payload] = mockSendFailure.mock.calls[0];
    expect(to).toBe("starter@example.com");
    expect(payload).toMatchObject({
      runId: "run_1",
      connectionName: "Support Agent",
      errorMessage: "endpoint unreachable",
    });
  });

  it("does not throw when the email send fails (best-effort)", async () => {
    mockSendFailure.mockRejectedValue(new Error("resend down"));
    await expect(
      failRun({ optRunId: "run_1", message: "endpoint unreachable" })
    ).resolves.toBeUndefined();
  });

  it("settles the point reservation as failed (ADR-0016: settles to scored rollouts)", async () => {
    await failRun({ optRunId: "run_1", message: "endpoint unreachable" });
    expect(mockRpc).toHaveBeenCalledWith("settle_optimization_run_points", {
      p_run_id: "run_1",
      p_outcome: "failed",
    });
  });
});

describe("pauseRun", () => {
  it("emails the starter with the pause reason and run id (#102)", async () => {
    await pauseRun({ optRunId: "run_1", reason: "endpoint stopped responding" });

    expect(mockSendPaused).toHaveBeenCalledTimes(1);
    const [to, payload] = mockSendPaused.mock.calls[0];
    expect(to).toBe("starter@example.com");
    expect(payload).toMatchObject({
      runId: "run_1",
      connectionName: "Support Agent",
      reason: "endpoint stopped responding",
    });
  });

  it("does not throw when the email send fails (best-effort)", async () => {
    mockSendPaused.mockRejectedValue(new Error("resend down"));
    await expect(
      pauseRun({ optRunId: "run_1", reason: "endpoint stopped responding" })
    ).resolves.toBeUndefined();
  });

  it("skips the email when the CAS doesn't transition the row (run already left 'running')", async () => {
    // A cancel landed while this activity was in flight (or a retried attempt already paused
    // the run): the guarded UPDATE matches no row, so nothing changed — no email either.
    state.updatedRows = [];
    await expect(
      pauseRun({ optRunId: "run_1", reason: "endpoint stopped responding" })
    ).resolves.toBeUndefined();
    expect(mockSendPaused).not.toHaveBeenCalled();
  });
});
