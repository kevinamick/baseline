// Coverage for #469: runOptimizationWorkflow must pass completeRun the right terminationReason
// whenever the run completes without ever entering iteration 1 — and null/undefined when it
// genuinely ran. Same technique as workflow.guard.test.ts / workflow.loop.test.ts: drive the
// REAL runOptimizationWorkflow, mocking only the Temporal SDK primitives and the Activities.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PARETO } from "./phase.js";

const h = vi.hoisted(() => ({
  acts: {} as Record<string, (...args: unknown[]) => unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  conditionImpl: { fn: async (..._args: unknown[]) => false as boolean },
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
  setHandler: () => {},
}));

import { runOptimizationWorkflow } from "./workflow.js";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "seed",
    instanceCount: 5,
    modules: ["main"],
    budgetRollouts: 100,
    maxIters: 5,
    plateauPatience: null,
    pauseMaxWaitMinutes: 60,
    probeIntervalSeconds: 60,
    ...overrides,
  };
}

function seedScore(overrides: Record<string, unknown> = {}) {
  return { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5, ...overrides };
}

describe("runOptimizationWorkflow — termination reason (#469)", () => {
  let seedRun: Mock;
  let rolloutCandidate: Mock;
  let proposeCandidate: Mock;
  let completeRun: Mock;
  let failRun: Mock;

  beforeEach(() => {
    h.conditionImpl.fn = async () => false;
    seedRun = vi.fn(async () => baseConfig());
    proposeCandidate = vi.fn(async () => ({ childCandidateId: "child1" }));
    completeRun = vi.fn(async () => {});
    failRun = vi.fn(async () => {});
    Object.assign(h.acts, { seedRun, proposeCandidate, completeRun, failRun });
  });

  it("records no_modules when the Connection has no optimizable Modules", async () => {
    seedRun = vi.fn(async () => baseConfig({ modules: [] }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async () => seedScore());
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    // Only the seed Pareto rollout ran — the loop's while condition never entered.
    expect(rolloutCandidate).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: "no_modules" }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });

  it("records no_instances when the frozen Instance set is empty", async () => {
    seedRun = vi.fn(async () => baseConfig({ instanceCount: 0 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async () => seedScore({ instancesRun: 0 }));
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: "no_instances" }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });

  it("records budget_exhausted_by_baseline when the seed alone exhausts the budget", async () => {
    // instanceCount=5, minibatch=5 -> entering iteration 1 needs rolloutsUsed(5) + 2*5 <= budget.
    // A budget of 5 admits the seed eval but nothing more.
    seedRun = vi.fn(async () => baseConfig({ budgetRollouts: 5 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async () => seedScore());
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    // Only the seed rollout ran — the budget guard refused iteration 1.
    expect(rolloutCandidate).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: "budget_exhausted_by_baseline" }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });

  it("records no termination reason once at least one iteration runs", async () => {
    rolloutCandidate = vi.fn(async (input: { phase: string; candidateId: string }) => {
      if (input.phase === PARETO && input.candidateId === "seed") return seedScore();
      // Every other rollout (parent minibatch, child minibatch, child follow-up) — reject the
      // child so the loop terminates quickly via maxIters=1 without extra branching to model.
      return { overallScore: 0.1, instanceScores: { 0: 0.1 }, instancesRun: 5 };
    });
    h.acts.rolloutCandidate = rolloutCandidate;
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: null }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });
});
