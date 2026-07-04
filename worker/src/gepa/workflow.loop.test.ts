// Coverage for the two big uncovered slices of runOptimizationWorkflow left by
// workflow.guard.test.ts (which pins the #102 pause-entry guard but only exercises the
// "always healthy" / "seed only" paths):
//
//   1. The iteration body's accept/reject/budget-break logic (childMini vs parentMini,
//      the full-set Pareto eval on an accepted child, frontier-gain bookkeeping, and the
//      budget-short-circuit that skips pooling an accepted child it can't afford to score).
//   2. The pause-and-wait probe loop's non-trivial branches: backoff-then-recover, the
//      "retry now" signal actually resuming (not just a mocked short-circuit), a probe
//      Activity that THROWS (vs. returning an unhealthy verdict), and the max-wait give-up
//      that fails the run.
//
// Same technique as workflow.guard.test.ts: drive the REAL runOptimizationWorkflow + REAL
// pareto/circuit-breaker/pause-control helpers, mocking only the Temporal SDK primitives and
// the Activities.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PARETO, MINIBATCH } from "./phase.js";
import { CIRCUIT_BREAKER_THRESHOLD } from "./circuit-breaker.js";
import { OPTIMIZATION_RETRY_NOW_SIGNAL } from "../temporal/connection.js";

const h = vi.hoisted(() => ({
  acts: {} as Record<string, (...args: unknown[]) => unknown>,
  // Per-test override of condition()'s behavior. Defaults to "timer always elapses".
  conditionImpl: { fn: (async () => false) as (...args: unknown[]) => Promise<unknown> },
  // setHandler stores the real signal callback here, keyed by signal name, so a test can
  // invoke the ACTUAL registered handler (exercising the workflow's own `retryNowRequested =
  // true` assignment) rather than just faking condition()'s return value.
  signalHandlers: {} as Record<string, () => void>,
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) =>
            h.acts[name](...args),
      },
    ),
  log: { warn() {}, info() {}, error() {}, debug() {} },
  ApplicationFailure: {
    create: (o: { message?: string }) => Object.assign(new Error(o?.message ?? "failure"), o),
  },
  condition: (...args: unknown[]) => h.conditionImpl.fn(...args),
  defineSignal: (name: string) => ({ name }),
  setHandler: (signal: { name: string }, cb: () => void) => {
    h.signalHandlers[signal.name] = cb;
  },
}));

import { runOptimizationWorkflow } from "./workflow.js";

function endpointError(): Error {
  return Object.assign(new Error("endpoint down"), { type: "AgentEndpointError" });
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "seed",
    instanceCount: 5,
    modules: ["main"],
    budgetRollouts: 100,
    maxIters: 1,
    plateauPatience: null,
    pauseMaxWaitMinutes: 60,
    probeIntervalSeconds: 60,
    ...overrides,
  };
}

describe("runOptimizationWorkflow — iteration accept/reject/budget logic", () => {
  let events: Array<{ candidateId: string; phase: string }>;
  let seedRun: Mock;
  let rolloutCandidate: Mock;
  let proposeCandidate: Mock;
  let probeEndpoint: Mock;
  let pauseRun: Mock;
  let resumeRun: Mock;
  let completeRun: Mock;
  let failRun: Mock;

  beforeEach(() => {
    events = [];
    h.conditionImpl.fn = async () => false;
    h.signalHandlers = {};

    seedRun = vi.fn(async () => baseConfig());
    proposeCandidate = vi.fn(async () => ({ childCandidateId: "child1" }));
    probeEndpoint = vi.fn(async () => ({ healthy: true }));
    pauseRun = vi.fn(async () => {});
    resumeRun = vi.fn(async () => {});
    completeRun = vi.fn(async () => {});
    failRun = vi.fn(async () => {});

    Object.assign(h.acts, {
      seedRun,
      proposeCandidate,
      probeEndpoint,
      pauseRun,
      resumeRun,
      completeRun,
      failRun,
    });
  });

  function trackedRollout(
    responses: Record<string, { overallScore: number; instanceScores: Record<number, number>; instancesRun: number }>,
  ) {
    return vi.fn(async (input: { candidateId: string; phase: string }) => {
      events.push({ candidateId: input.candidateId, phase: input.phase });
      const key = `${input.candidateId}:${input.phase}`;
      const result = responses[key];
      if (!result) throw new Error(`Unexpected rollout call: ${key}`);
      return result;
    });
  }

  it("accepts a child that beats the parent, scores it on the full set, and promotes it to best when it expands the frontier", async () => {
    rolloutCandidate = trackedRollout({
      "seed:pareto": { overallScore: 0.5, instanceScores: { 0: 0.5, 1: 0.5 }, instancesRun: 5 },
      "seed:minibatch": { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 },
      "child1:minibatch": { overallScore: 0.7, instanceScores: { 0: 0.7 }, instancesRun: 5 },
      "child1:pareto": { overallScore: 0.9, instanceScores: { 0: 0.9, 1: 0.4 }, instancesRun: 5 },
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(events).toEqual([
      { candidateId: "seed", phase: PARETO },
      { candidateId: "seed", phase: MINIBATCH },
      { candidateId: "child1", phase: MINIBATCH },
      { candidateId: "child1", phase: PARETO },
    ]);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        optRunId: "run_1",
        bestCandidateId: "child1",
        overallScore: 0.9,
        seedScore: 0.5,
        rolloutsUsed: 20, // 5 (seed pareto) + 5 (parent mini) + 5 (child mini) + 5 (child pareto)
      }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });

  it("rejects a child that does not beat the parent — never spends the full-set eval on it", async () => {
    rolloutCandidate = trackedRollout({
      "seed:pareto": { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 },
      "seed:minibatch": { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 },
      "child1:minibatch": { overallScore: 0.3, instanceScores: { 0: 0.3 }, instancesRun: 5 },
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(events).toEqual([
      { candidateId: "seed", phase: PARETO },
      { candidateId: "seed", phase: MINIBATCH },
      { candidateId: "child1", phase: MINIBATCH },
    ]);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        bestCandidateId: "seed",
        overallScore: 0.5,
        rolloutsUsed: 15,
      }),
    );
  });

  it("stops before spending an unaffordable full-set eval on an accepted child (budget short-circuit)", async () => {
    // instanceCount 5, minibatch 5: entering the loop needs rolloutsUsed(5) + 2*5 <= budget, so
    // budget=17 admits the iteration; after the accepted minibatch pair rolloutsUsed=15, and
    // 15 + instanceCount(5) = 20 > 17, so the child's full Pareto eval is skipped entirely.
    seedRun = vi.fn(async () => baseConfig({ budgetRollouts: 17, maxIters: 5 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = trackedRollout({
      "seed:pareto": { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 },
      "seed:minibatch": { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 },
      "child1:minibatch": { overallScore: 0.9, instanceScores: { 0: 0.9 }, instancesRun: 5 },
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    // No child1:pareto call — the budget short-circuit broke the loop first.
    expect(events).toEqual([
      { candidateId: "seed", phase: PARETO },
      { candidateId: "seed", phase: MINIBATCH },
      { candidateId: "child1", phase: MINIBATCH },
    ]);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        bestCandidateId: "seed", // never promoted — child was never scored on the full set
        overallScore: 0.5,
        rolloutsUsed: 15,
      }),
    );
  });
});

describe("runOptimizationWorkflow — pause-and-wait probe loop (#102)", () => {
  let events: string[];
  let seedRun: Mock;
  let rolloutCandidate: Mock;
  let proposeCandidate: Mock;
  let probeEndpoint: Mock;
  let pauseRun: Mock;
  let resumeRun: Mock;
  let completeRun: Mock;
  let failRun: Mock;

  function seedScore() {
    return { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 };
  }

  beforeEach(() => {
    events = [];
    h.conditionImpl.fn = async () => false;
    h.signalHandlers = {};

    seedRun = vi.fn(async () => baseConfig({ maxIters: CIRCUIT_BREAKER_THRESHOLD }));
    proposeCandidate = vi.fn(async () => ({ childCandidateId: "child" }));
    pauseRun = vi.fn(async () => void events.push("paused"));
    resumeRun = vi.fn(async () => void events.push("resumed"));
    completeRun = vi.fn(async () => void events.push("completed"));
    failRun = vi.fn(async (input: { message: string }) => void events.push(`failed:${input.message}`));

    Object.assign(h.acts, { seedRun, proposeCandidate, pauseRun, resumeRun, completeRun, failRun });

    // Trips the breaker on the very first CIRCUIT_BREAKER_THRESHOLD iterations, every test in
    // this block; only probeEndpoint's behavior varies per test.
    rolloutCandidate = vi.fn(async (input: { phase: string }) => {
      if (input.phase === PARETO) {
        events.push("seed-scored");
        return seedScore();
      }
      events.push("rollout-failed");
      throw endpointError();
    });
    h.acts.rolloutCandidate = rolloutCandidate;
  });

  it("resumes on a retry-now signal via the REAL setHandler wiring, without waiting for a probe", async () => {
    probeEndpoint = vi.fn(async () => ({ healthy: false, message: "still down" }));
    h.acts.probeEndpoint = probeEndpoint;

    // Simulate the signal arriving mid-wait: invoke the handler runOptimizationWorkflow itself
    // registered via setHandler (covers the real `retryNowRequested = true` assignment), then
    // resolve condition() with the (now-true) predicate — exactly what @temporalio/workflow's
    // real condition() would do once the signal lands.
    h.conditionImpl.fn = async (...args: unknown[]) => {
      const predicate = args[0] as () => boolean;
      h.signalHandlers[OPTIMIZATION_RETRY_NOW_SIGNAL]?.();
      return predicate();
    };

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(pauseRun).toHaveBeenCalledTimes(1);
    // The probe was never even consulted — the signal resumed the loop before the probe ran.
    expect(probeEndpoint).not.toHaveBeenCalled();
    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(failRun).not.toHaveBeenCalled();
  });

  it("backs off after a failed probe and resumes once a later probe reports healthy", async () => {
    probeEndpoint = vi
      .fn()
      .mockResolvedValueOnce({ healthy: false, message: "still down" })
      .mockResolvedValueOnce({ healthy: true });
    h.acts.probeEndpoint = probeEndpoint;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(probeEndpoint).toHaveBeenCalledTimes(2);
    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(failRun).not.toHaveBeenCalled();
  });

  it("treats a probe Activity that THROWS as still down (not a crash, not a false recovery)", async () => {
    probeEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error("activity timed out"))
      .mockResolvedValueOnce({ healthy: true });
    h.acts.probeEndpoint = probeEndpoint;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(probeEndpoint).toHaveBeenCalledTimes(2);
    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
  });

  it("gives up and fails the run once sustained probe failures exceed the max-wait cap", async () => {
    // probeIntervalSeconds*1000 === pauseMaxWaitMinutes*60*1000 -> the very first failed probe's
    // elapsed time reaches the cap, so this hits "give-up" on the first wait step.
    seedRun = vi.fn(async () =>
      baseConfig({
        maxIters: CIRCUIT_BREAKER_THRESHOLD,
        pauseMaxWaitMinutes: 1,
        probeIntervalSeconds: 60,
      }),
    );
    h.acts.seedRun = seedRun;
    probeEndpoint = vi.fn(async () => ({ healthy: false, message: "still down" }));
    h.acts.probeEndpoint = probeEndpoint;

    await expect(runOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(
      /did not recover within the 1-minute pause budget/,
    );

    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect(resumeRun).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.startsWith("failed:") && e.includes("pause budget"))).toBe(true);
  });
});
