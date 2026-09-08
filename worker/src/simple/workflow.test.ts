// Coverage for the Simple (Monte Carlo) Optimization Workflow (#316, ADR-0015), previously
// completely untested. Same technique as gepa/workflow.guard.test.ts and
// gepa/workflow.loop.test.ts: drive the REAL runSimpleOptimizationWorkflow + REAL
// topK/sampleElite/circuit-breaker helpers, mocking only the Temporal SDK primitives and the
// Activities. Simple Mode has no pause-and-wait / circuit breaker (no customer endpoint), so
// the mock surface is smaller than GEPA's: no condition()/signals needed.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  MANAGED_AGENT_CONFIG_TYPE,
  PROVIDER_KEY_MISSING_TYPE,
} from "../gepa/circuit-breaker.js";

const h = vi.hoisted(() => ({
  acts: {} as Record<string, (...args: unknown[]) => unknown>,
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
}));

import { runSimpleOptimizationWorkflow } from "./workflow.js";

function terminalKeyError(): Error {
  return Object.assign(new Error("no provider key"), {
    type: PROVIDER_KEY_MISSING_TYPE,
  });
}

function managedAgentConfigError(): Error {
  return Object.assign(new Error("managed agent target_model is invalid"), {
    type: MANAGED_AGENT_CONFIG_TYPE,
  });
}

function providerKeyMissingError(): Error {
  return Object.assign(new Error("no provider key available"), {
    type: PROVIDER_KEY_MISSING_TYPE,
  });
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "seed",
    instanceCount: 5,
    modules: ["main"],
    budgetRollouts: 1000,
    maxIters: 1,
    plateauPatience: null,
    ...overrides,
  };
}

describe("runSimpleOptimizationWorkflow", () => {
  let seedRun: Mock;
  let rolloutCandidate: Mock;
  let proposeSimpleCandidate: Mock;
  let completeRun: Mock;
  let failRun: Mock;

  beforeEach(() => {
    seedRun = vi.fn(async () => baseConfig());
    rolloutCandidate = vi.fn(async () => ({ overallScore: 0.5, instanceScores: {}, instancesRun: 5 }));
    proposeSimpleCandidate = vi.fn(async ({ iteration }: { iteration: number }) => ({
      childCandidateId: `child-${iteration}`,
    }));
    completeRun = vi.fn(async () => {});
    failRun = vi.fn(async () => {});

    Object.assign(h.acts, {
      seedRun,
      rolloutCandidate,
      proposeSimpleCandidate,
      completeRun,
      failRun,
    });
  });

  it("promotes a variant that beats the seed to best, and sums rollouts across the round", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async (input: { candidateId: string }) => {
      if (input.candidateId === "seed") return { overallScore: 0.5, instanceScores: {}, instancesRun: 5 };
      // The first-generated variant (child-1) beats the seed; the rest don't.
      const score = input.candidateId === "child-1" ? 0.9 : 0.4;
      return { overallScore: score, instanceScores: {}, instancesRun: 5 };
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    // POPULATION_SIZE (8) variants generated in the single round.
    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(8);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        optRunId: "run_1",
        bestCandidateId: "child-1",
        overallScore: 0.9,
        seedScore: 0.5,
        rolloutsUsed: 5 + 8 * 5, // seed + 8 full-set variant scorings
      }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });

  it("logs and continues past a non-terminal variant failure without discarding the round", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;
    let calls = 0;
    proposeSimpleCandidate = vi.fn(async ({ iteration }: { iteration: number }) => {
      calls += 1;
      if (calls === 3) throw new Error("generation model returned nothing usable");
      return { childCandidateId: `child-${iteration}` };
    });
    h.acts.proposeSimpleCandidate = proposeSimpleCandidate;

    await expect(runSimpleOptimizationWorkflow({ optRunId: "run_1" })).resolves.toBeUndefined();

    // All 8 population slots were attempted despite the one failure.
    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(8);
    expect(failRun).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledTimes(1);
  });

  it("fails the run terminally (does not continue the round) on a missing-provider-key error", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async (input: { candidateId: string }) => {
      if (input.candidateId === "seed") return { overallScore: 0.5, instanceScores: {}, instancesRun: 5 };
      throw terminalKeyError();
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await expect(runSimpleOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(
      /no provider key/,
    );

    // Only the first variant's rollout was attempted before the terminal failure propagated.
    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(1);
    expect(rolloutCandidate).toHaveBeenCalledTimes(2); // seed + the one failing variant
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("fails the run terminally on a managed-agent-config error thrown by rolloutCandidate (#415)", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async (input: { candidateId: string }) => {
      if (input.candidateId === "seed") return { overallScore: 0.5, instanceScores: {}, instancesRun: 5 };
      throw managedAgentConfigError();
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await expect(runSimpleOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(
      /managed agent target_model is invalid/,
    );

    // Only the first variant's rollout was attempted before the terminal failure propagated —
    // the run fails rather than completing on the seed.
    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(1);
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("fails the run terminally on a provider-key-missing error thrown by proposeSimpleCandidate (#415)", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;
    proposeSimpleCandidate = vi.fn(async () => {
      throw providerKeyMissingError();
    });
    h.acts.proposeSimpleCandidate = proposeSimpleCandidate;

    await expect(runSimpleOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(
      /no provider key available/,
    );

    // The rollout Activity is never reached for the first variant — proposeSimpleCandidate fails
    // first — and the run fails rather than completing on the seed.
    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(1);
    expect(rolloutCandidate).toHaveBeenCalledTimes(1); // seed only
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("stops generating variants once the round's budget short-circuit triggers", async () => {
    // instanceCount 5; after the seed (5), 3 more full-set scorings (15) exactly fill a budget
    // of 20 (5+5<=20, 10+5<=20, 15+5<=20), and the 4th would overrun it (20+5>20) and breaks.
    seedRun = vi.fn(async () => baseConfig({ maxIters: 5, budgetRollouts: 20 }));
    h.acts.seedRun = seedRun;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(3);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ rolloutsUsed: 20 }),
    );
  });

  it("completes immediately on the seed when there are no Modules to tune", async () => {
    seedRun = vi.fn(async () => baseConfig({ modules: [] }));
    h.acts.seedRun = seedRun;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    expect(proposeSimpleCandidate).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        bestCandidateId: "seed",
        overallScore: 0.5,
        // #469: a degenerate completion carries a reason code instead of looking like a
        // genuine (if unlucky) optimization pass.
        terminationReason: "no_modules",
      }),
    );
  });

  it("records no_instances when the frozen Instance set is empty (#469)", async () => {
    seedRun = vi.fn(async () => baseConfig({ instanceCount: 0 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async () => ({ overallScore: 0.5, instanceScores: {}, instancesRun: 0 }));
    h.acts.rolloutCandidate = rolloutCandidate;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    expect(proposeSimpleCandidate).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: "no_instances" }),
    );
  });

  it("records budget_exhausted_by_baseline when the seed alone exhausts the budget (#469)", async () => {
    // instanceCount 5, budgetRollouts 5: the seed's own full-set eval spends the whole budget, so
    // round 1's guaranteed cost (another 5) can't fit — the round loop never enters.
    seedRun = vi.fn(async () => baseConfig({ budgetRollouts: 5, maxIters: 5 }));
    h.acts.seedRun = seedRun;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    expect(proposeSimpleCandidate).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: "budget_exhausted_by_baseline" }),
    );
  });

  it("records no termination reason once at least one round runs (#469)", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 1 }));
    h.acts.seedRun = seedRun;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(8);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminationReason: null }),
    );
  });

  it("stops after plateauPatience rounds produce no new best", async () => {
    seedRun = vi.fn(async () => baseConfig({ maxIters: 100, plateauPatience: 1, budgetRollouts: 100000 }));
    h.acts.seedRun = seedRun;
    // Every variant scores strictly worse than the seed — no round ever improves the best.
    rolloutCandidate = vi.fn(async (input: { candidateId: string }) => ({
      overallScore: input.candidateId === "seed" ? 0.5 : 0.1,
      instanceScores: {},
      instancesRun: 5,
    }));
    h.acts.rolloutCandidate = rolloutCandidate;

    await runSimpleOptimizationWorkflow({ optRunId: "run_1" });

    // Exactly one round (8 variants) ran before the plateau (patience 1) stopped the loop.
    expect(proposeSimpleCandidate).toHaveBeenCalledTimes(8);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ bestCandidateId: "seed", overallScore: 0.5 }),
    );
  });
});
