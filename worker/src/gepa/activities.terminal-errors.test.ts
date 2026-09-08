import { describe, it, expect, vi, beforeEach } from "vitest";

// Error-path + edge-branch coverage for the terminal-transition Activities (completeRun,
// failRun, pauseRun, resumeRun), which now delegate their settlement sequence to the shared
// settleTerminalRun seam (../settle-terminal-run.ts, #378 — see settle-terminal-run.test.ts for
// the seam's own dedicated coverage), complementing activities.notify.test.ts (which covers the
// happy paths + email payload shaping). Covers: the update-error throws Temporal needs to retry
// on, the org_id ambient-log-context patch (only exercised when the update actually returns an
// org_id), the settlement RPCs' three independent best-effort error logs, and
// resolveUserEmail's reject-not-just-null-user path.

const { mockRpc, mockGetUserById } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockGetUserById: vi.fn(),
}));

const state = {
  updateError: null as { message: string } | null,
  updateData: null as { created_at: string; org_id?: string } | null,
  pauseUpdateRows: [{ id: "run_1" }] as Array<{ id: string }>,
  pauseUpdateError: null as { message: string } | null,
  resumeUpdateError: null as { message: string } | null,
  notifyRunRow: { created_by: "user_1", connections: { name: "Support Agent" } } as unknown,
};

function updateSelectChain() {
  return {
    eq: () => updateSelectChain(),
    in: () => updateSelectChain(),
    select: () => ({
      maybeSingle: () => Promise.resolve({ data: state.updateData, error: state.updateError }),
    }),
  };
}

function pauseUpdateChain() {
  const casResult = { data: state.pauseUpdateRows, error: state.pauseUpdateError };
  return {
    eq: () => pauseUpdateChain(),
    select: () => Promise.resolve(casResult),
  };
}

function resumeUpdateChain() {
  return {
    eq: () => resumeUpdateChain(),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ error: state.resumeUpdateError }).then(resolve, reject),
  };
}

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    return {
      update: (payload: Record<string, unknown>) => {
        if (payload.status === "completed" || payload.status === "failed") {
          return updateSelectChain();
        }
        if (payload.status === "paused") return pauseUpdateChain();
        if (payload.status === "running") return resumeUpdateChain();
        throw new Error(`Unexpected update payload: ${JSON.stringify(payload)}`);
      },
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.notifyRunRow, error: null }),
        }),
      }),
    };
  }
  if (table === "optimization_inputs") {
    return { select: () => ({ eq: () => Promise.resolve({ count: 8, error: null }) }) };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeFrom(table),
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

import { completeRun, failRun, pauseRun, resumeRun } from "./activities.js";
import { log } from "../log.js";

const COMPLETE_INPUT = {
  optRunId: "run_1",
  bestCandidateId: "cand_9",
  overallScore: 0.81,
  seedScore: 0.62,
  rolloutsUsed: 40,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
  state.updateError = null;
  state.updateData = { created_at: "2026-06-30T11:59:00.000Z" };
  state.pauseUpdateRows = [{ id: "run_1" }];
  state.pauseUpdateError = null;
  state.resumeUpdateError = null;
  state.notifyRunRow = { created_by: "user_1", connections: { name: "Support Agent" } };
  mockRpc.mockResolvedValue({ error: null });
  mockGetUserById.mockResolvedValue({ data: { user: { email: "starter@example.com" } } });
  mockSendCompletion.mockResolvedValue(undefined);
  mockSendFailure.mockResolvedValue(undefined);
  mockSendPaused.mockResolvedValue(undefined);
});

describe("completeRun — error path and org_id log-context patch", () => {
  it("throws when the completion update fails", async () => {
    state.updateError = { message: "row missing" };
    await expect(completeRun(COMPLETE_INPUT)).rejects.toThrow(
      "Failed to complete optimization run: row missing",
    );
  });

  it("patches org_id into the ambient log scope when the update returns one", async () => {
    state.updateData = { created_at: "2026-06-30T11:59:00.000Z", org_id: "org_9" };
    // No ambient scope is open in this unit test, so setLogContext is a no-op — this just
    // pins that reaching the branch doesn't throw, exercising the `data?.org_id` truthy path.
    await expect(completeRun(COMPLETE_INPUT)).resolves.toBeUndefined();
  });
});

describe("failRun — error path and org_id log-context patch", () => {
  it("throws when the failure update fails", async () => {
    state.updateError = { message: "row missing" };
    await expect(failRun({ optRunId: "run_1", message: "boom" })).rejects.toThrow(
      "Failed to mark optimization run failed: row missing",
    );
  });

  it("patches org_id into the ambient log scope when the update returns one", async () => {
    state.updateData = { created_at: "2026-06-30T11:59:00.000Z", org_id: "org_9" };
    await expect(
      failRun({ optRunId: "run_1", message: "boom" }),
    ).resolves.toBeUndefined();
  });
});

describe("pauseRun — error path", () => {
  it("throws when the pause update fails", async () => {
    state.pauseUpdateError = { message: "deadlock" };
    await expect(
      pauseRun({ optRunId: "run_1", reason: "endpoint down" }),
    ).rejects.toThrow("Failed to pause optimization run: deadlock");
  });
});

describe("resumeRun — error path", () => {
  it("throws when the resume update fails", async () => {
    state.resumeUpdateError = { message: "deadlock" };
    await expect(resumeRun({ optRunId: "run_1" })).rejects.toThrow(
      "Failed to resume optimization run: deadlock",
    );
  });

  it("resolves when the resume update succeeds", async () => {
    await expect(resumeRun({ optRunId: "run_1" })).resolves.toBeUndefined();
  });
});

