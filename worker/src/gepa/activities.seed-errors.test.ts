import { describe, it, expect, vi, beforeEach } from "vitest";

// Error-path coverage for seedRun, complementing activities.seed.test.ts (which covers the
// happy path + the structured started-log). Each of seedRun's four sequential DB calls can
// fail independently: the status=running UPDATE, the instance-count SELECT, the existing-seed
// existence check, and the seed INSERT.

const state = {
  runRow: {
    id: "run_1",
    org_id: "org_1",
    connection_id: "conn_1",
    rubric_id: "rub_1",
    eval_type: "dataset",
    reflect_model: "claude-3-5-sonnet",
    budget_rollouts: 40,
    max_iters: 6,
    plateau_patience: 2,
    pause_max_wait_minutes: 30,
    probe_interval_seconds: 60,
  } as Record<string, unknown> | null,
  connectionRow: {
    id: "conn_1",
    kind: "agent",
    optimizable_prompts: [{ name: "system" }],
  } as Record<string, unknown> | null,
  statusUpdateError: null as { message: string } | null,
  instanceCount: 8 as number | null,
  instanceCountError: null as { message: string } | null,
  existingCandidate: null as { id: string } | null,
  existingCandidateError: null as { message: string } | null,
  insertResult: { id: "cand_seed" } as { id: string } | null,
  insertError: null as { message: string } | null,
};

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.runRow, error: null }),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: state.statusUpdateError }),
      }),
    };
  }
  if (table === "connections") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.connectionRow, error: null }),
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
  if (table === "optimization_candidates") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: state.existingCandidate,
                error: state.existingCandidateError,
              }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: state.insertResult, error: state.insertError }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (table: string) => makeFrom(table) }),
}));

vi.mock("./scoring.js", () => ({
  seedPromptsFor: () => ({}),
  perInstanceScores: () => ({}),
}));

import { seedRun } from "./activities.js";
import { log } from "../log.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => {});
  state.statusUpdateError = null;
  state.instanceCount = 8;
  state.instanceCountError = null;
  state.existingCandidate = null;
  state.existingCandidateError = null;
  state.insertResult = { id: "cand_seed" };
  state.insertError = null;
});

describe("seedRun — error paths", () => {
  it("throws when marking the run as running fails", async () => {
    state.statusUpdateError = { message: "row locked" };
    await expect(seedRun("run_1")).rejects.toThrow(
      "Failed to mark optimization run as running: row locked",
    );
  });

  it("throws when counting optimization instances fails", async () => {
    state.instanceCountError = { message: "count timeout" };
    await expect(seedRun("run_1")).rejects.toThrow(
      "Failed to count optimization instances: count timeout",
    );
  });

  it("throws when checking for an existing seed candidate fails", async () => {
    state.existingCandidateError = { message: "index corrupt" };
    await expect(seedRun("run_1")).rejects.toThrow(
      "Failed to check existing seed candidate: index corrupt",
    );
  });

  it("throws when inserting the seed candidate fails", async () => {
    state.insertResult = null;
    state.insertError = { message: "unique violation" };
    await expect(seedRun("run_1")).rejects.toThrow(
      "Failed to seed candidate: unique violation",
    );
  });

  it("throws when the seed candidate insert returns no row and no error", async () => {
    state.insertResult = null;
    await expect(seedRun("run_1")).rejects.toThrow("Failed to seed candidate: undefined");
  });
});
