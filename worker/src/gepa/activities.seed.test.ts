import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
// seedRun touches four tables: optimization_runs (loadRun's select + the status=running
// UPDATE), connections (loadConnection), optimization_inputs (instance count), and
// optimization_candidates (the generation-0 seed check + insert). Each is driven by a thin
// per-table stub so the test asserts the structured `optimization_run.started` lifecycle log
// without a real DB.

const { state } = vi.hoisted(() => ({
  state: {
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
      optimizable_prompts: [{ name: "system" }, { name: "tools" }],
    } as Record<string, unknown> | null,
    instanceCount: 8 as number | null,
    // The existing generation-0 candidate (null = none yet, so seedRun inserts a fresh one).
    existingCandidate: null as { id: string } | null,
  },
}));

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    return {
      // loadRun: select(cols).eq().maybeSingle()
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.runRow, error: null }),
        }),
      }),
      // status=running UPDATE: update().eq() awaited
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
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
        eq: () => Promise.resolve({ count: state.instanceCount, error: null }),
      }),
    };
  }
  if (table === "optimization_candidates") {
    return {
      // existing seed check: select("id").eq().eq().maybeSingle()
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: state.existingCandidate, error: null }),
          }),
        }),
      }),
      // fresh insert: insert({...}).select("id").single()
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: "cand_seed" }, error: null }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (table: string) => makeFrom(table) }),
}));

// seedPromptsFor is the only ./scoring.js helper seedRun uses; keep it trivial so the test
// stays focused on the lifecycle log rather than seed-prompt shaping.
vi.mock("./scoring.js", () => ({
  seedPromptsFor: () => ({}),
  perInstanceScores: () => ({}),
}));

// The system-aware-merge kill switch (#84): seedRun resolves the PostHog flag once per run via
// this telemetry helper and carries the verdict as SeedRunResult.mergeEnabled. The helper's own
// default matrix (unconfigured -> enabled; configured error/undefined -> disabled) is pinned in
// telemetry.flag.test.ts; here it's mocked so these tests assert seedRun's pass-through wiring.
const { mockKillSwitch } = vi.hoisted(() => ({ mockKillSwitch: vi.fn() }));
vi.mock("../telemetry.js", () => ({ isKillSwitchFlagEnabled: mockKillSwitch }));

import { seedRun } from "./activities.js";
import { log } from "../log.js";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(log, "info").mockImplementation(() => {});
  state.existingCandidate = null;
  state.instanceCount = 8;
  mockKillSwitch.mockResolvedValue(true);
});

describe("seedRun", () => {
  it("emits a structured optimization_run.started log with module/instance counts and budget", async () => {
    await seedRun("run_1");
    expect(log.info).toHaveBeenCalledWith(
      "Optimization run started",
      expect.objectContaining({
        event: "optimization_run.started",
        opt_run_id: "run_1",
        module_count: 2,
        instance_count: 8,
        budget_rollouts: 40,
        max_iters: 6,
      })
    );
  });

  it("still emits the started log when a generation-0 candidate already exists (idempotent retry)", async () => {
    state.existingCandidate = { id: "cand_existing" };
    const result = await seedRun("run_1");
    expect(result.candidateId).toBe("cand_existing");
    expect(log.info).toHaveBeenCalledWith(
      "Optimization run started",
      expect.objectContaining({ event: "optimization_run.started" })
    );
  });

  it("reports instance_count 0 when the instance count query yields null", async () => {
    state.instanceCount = null;
    await seedRun("run_1");
    const attrs = vi.mocked(log.info).mock.calls[0][1] as Record<string, unknown>;
    expect(attrs.instance_count).toBe(0);
  });

  it("resolves the system-aware-merge kill switch per Team and carries it as mergeEnabled (#84)", async () => {
    const result = await seedRun("run_1");
    expect(mockKillSwitch).toHaveBeenCalledWith("system-aware-merge", "org_1");
    expect(result.mergeEnabled).toBe(true);
  });

  it("carries mergeEnabled: false when the flag resolves disabled (configured-off or unreadable control plane)", async () => {
    mockKillSwitch.mockResolvedValue(false);
    const result = await seedRun("run_1");
    expect(result.mergeEnabled).toBe(false);
  });

  it("carries the default merge cadence when MERGE_EVERY_K_ITERS is unset (#84)", async () => {
    vi.stubEnv("MERGE_EVERY_K_ITERS", "");
    const result = await seedRun("run_1");
    expect(result.mergeEveryKIters).toBe(5);
  });

  it("carries an operator-set MERGE_EVERY_K_ITERS cadence", async () => {
    vi.stubEnv("MERGE_EVERY_K_ITERS", "3");
    const result = await seedRun("run_1");
    expect(result.mergeEveryKIters).toBe(3);
  });

  it("falls back to the default cadence on an invalid MERGE_EVERY_K_ITERS value", async () => {
    vi.stubEnv("MERGE_EVERY_K_ITERS", "-4");
    const result = await seedRun("run_1");
    expect(result.mergeEveryKIters).toBe(5);
  });
});
