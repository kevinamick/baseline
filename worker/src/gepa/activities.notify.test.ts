import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
// The notification path touches three things: optimization_runs (status update + created_by /
// connection name read), optimization_inputs (instance count), and auth.admin (starter email).
// We drive each via a thin per-table query stub so the test asserts recipient resolution and
// payload shaping without a real DB.

const { state, mockGetUserById } = vi.hoisted(() => ({
  state: {
    runRow: null as unknown,
    runError: null as unknown,
    instanceCount: 0 as number | null,
  },
  mockGetUserById: vi.fn(),
}));

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    // Two shapes are used on this table: an update().eq() (the status write) and a
    // select(...).eq().maybeSingle() (the notification read). Return a chainable that
    // satisfies both; maybeSingle resolves the run row.
    return {
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.runRow, error: state.runError }),
        }),
      }),
    };
  }
  if (table === "optimization_inputs") {
    return {
      select: () => ({ eq: () => Promise.resolve({ count: state.instanceCount }) }),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeFrom(table),
    // Allowance settlement (#181) fires on every terminal transition.
    rpc: vi.fn().mockResolvedValue({ error: null }),
    auth: { admin: { getUserById: mockGetUserById } },
  }),
}));

const { mockSendCompletion, mockSendFailure } = vi.hoisted(() => ({
  mockSendCompletion: vi.fn(),
  mockSendFailure: vi.fn(),
}));

vi.mock("../optimization-emailer.js", () => ({
  sendOptimizationCompletionEmail: mockSendCompletion,
  sendOptimizationFailureEmail: mockSendFailure,
}));

import { completeRun, failRun, loadRunNotification } from "./activities.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.runRow = {
    created_by: "user_1",
    connections: { name: "Support Agent" },
  };
  state.runError = null;
  state.instanceCount = 8;
  mockGetUserById.mockResolvedValue({ data: { user: { email: "starter@example.com" } } });
  mockSendCompletion.mockResolvedValue(undefined);
  mockSendFailure.mockResolvedValue(undefined);
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
});
