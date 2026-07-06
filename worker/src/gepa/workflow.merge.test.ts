// Coverage for the system-aware merge/crossover step (#84) inside runOptimizationWorkflow.
// Same technique as workflow.loop.test.ts: drive the REAL runOptimizationWorkflow + REAL
// pareto/merge/circuit-breaker helpers, mocking only the Temporal SDK primitives and the
// Activities. No patched()/versioning gate — this is a direct change to the live GEPA loop
// (there are no in-flight Optimization Runs to replay).
//
// Test design: iteration 1's proposed child ("child1") is always accepted and scored
// complementary to the seed (seed wins instance 1, child1 wins instance 0), so the pool is
// exactly [seed, child1] by the time the merge cadence (default 5) trips. Every later mutation child
// (child2, child3, ...) is scored below BOTH pool members' minibatch scores, so it's always
// rejected regardless of which pool member `sampleParent`'s Math.random() draw happens to pick
// as parent — keeping the pool exactly [seed, child1] (deterministically) through iteration 5,
// with no need to mock Math.random itself.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PARETO, MINIBATCH } from "./phase.js";
import { DEFAULT_MERGE_EVERY_K_ITERS } from "./merge.js";

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
  condition: async () => false,
  defineSignal: (name: string) => ({ name }),
  setHandler: () => {},
}));

import { runOptimizationWorkflow } from "./workflow.js";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "seed",
    instanceCount: 5,
    modules: ["a", "b"],
    budgetRollouts: 1000,
    maxIters: DEFAULT_MERGE_EVERY_K_ITERS,
    plateauPatience: null,
    pauseMaxWaitMinutes: 60,
    probeIntervalSeconds: 60,
    // The PostHog kill switch (resolved per run in seedRun) defaults ON here so the merge-path
    // tests exercise the feature; the flag-off test overrides it explicitly. The cadence rides
    // the seedRun result the same way (MERGE_EVERY_K_ITERS env knob, resolved per run); most
    // tests use the default, the non-default-K test overrides it.
    mergeEnabled: true,
    mergeEveryKIters: DEFAULT_MERGE_EVERY_K_ITERS,
    ...overrides,
  };
}

// Rollout scores for seed/child1, shared by every test in this file: seed and child1 are
// complementary winners (each wins exactly one instance the other loses), with distinct overall
// scores (child1 > seed) so combineModulePrompts' tie-break never enters into it.
const SEED_PARETO = { overallScore: 0.5, instanceScores: { 0: 0.5, 1: 0.5 }, instancesRun: 5 };
const SEED_MINI = { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 };
const CHILD1_MINI = { overallScore: 0.9, instanceScores: { 0: 0.9 }, instancesRun: 5 };
const CHILD1_PARETO = { overallScore: 0.6, instanceScores: { 0: 0.9, 1: 0.1 }, instancesRun: 5 };
// Any later mutation child (child2+) always loses to whichever parent minibatch score it's
// compared against (0.5 or 0.6) — keeps the pool frozen at [seed, child1] through iteration 5.
const LOSING_CHILD_MINI = { overallScore: 0.3, instanceScores: { 0: 0.3 }, instancesRun: 5 };

describe("runOptimizationWorkflow — system-aware merge (#84)", () => {
  let events: Array<{ candidateId: string; phase: string }>;
  let seedRun: Mock;
  let rolloutCandidate: Mock;
  let proposeCandidate: Mock;
  let mergeCandidates: Mock;
  let completeRun: Mock;
  let failRun: Mock;
  let childSeq: number;

  beforeEach(() => {
    events = [];
    childSeq = 0;

    seedRun = vi.fn(async () => baseConfig());
    proposeCandidate = vi.fn(async () => {
      childSeq += 1;
      return { childCandidateId: `child${childSeq}` };
    });
    completeRun = vi.fn(async () => {});
    failRun = vi.fn(async () => {});

    rolloutCandidate = vi.fn(async (input: { candidateId: string; phase: string }) => {
      events.push({ candidateId: input.candidateId, phase: input.phase });
      if (input.candidateId === "seed" && input.phase === PARETO) return SEED_PARETO;
      if (input.candidateId === "seed" && input.phase === MINIBATCH) return SEED_MINI;
      if (input.candidateId === "child1" && input.phase === MINIBATCH) return CHILD1_MINI;
      if (input.candidateId === "child1" && input.phase === PARETO) return CHILD1_PARETO;
      if (input.candidateId === "hybrid" && input.phase === PARETO) return h.acts._hybridResult();
      if (input.phase === MINIBATCH) return LOSING_CHILD_MINI;
      throw new Error(`Unexpected rollout call: ${input.candidateId}:${input.phase}`);
    });

    Object.assign(h.acts, {
      seedRun,
      proposeCandidate,
      rolloutCandidate,
      completeRun,
      failRun,
      // Every test overrides these two directly.
      mergeCandidates: vi.fn(),
      _hybridResult: () => ({ overallScore: 0, instanceScores: {}, instancesRun: 0 }),
    });
  });

  it("attempts a merge at iteration K, evaluates the hybrid on the full set, and keeps it when it beats both parents", async () => {
    mergeCandidates = vi.fn(async () => ({ hybridCandidateId: "hybrid" }));
    h.acts.mergeCandidates = mergeCandidates;
    h.acts._hybridResult = () => ({
      overallScore: 0.7, // beats both seed (0.5) and child1 (0.6)
      instanceScores: { 0: 0.95, 1: 0.6 },
      instancesRun: 5,
    });

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(mergeCandidates).toHaveBeenCalledTimes(1);
    expect(mergeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        optRunId: "run_1",
        aCandidateId: "seed",
        aOverallScore: 0.5,
        bCandidateId: "child1",
        bOverallScore: 0.6,
        modules: ["a", "b"],
        mergeIteration: -1, // afterIters(5) / mergeEveryKIters(5) = 1, negated: the first merge attempt
      }),
    );
    // The hybrid was rolled out on the full (PARETO) set, never a minibatch.
    expect(events.filter((e) => e.candidateId === "hybrid")).toEqual([
      { candidateId: "hybrid", phase: PARETO },
    ]);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ bestCandidateId: "hybrid", overallScore: 0.7 }),
    );
    expect(failRun).not.toHaveBeenCalled();
  });

  it("rejects a hybrid that doesn't beat both parents — it's recorded but never sampled as a parent again", async () => {
    mergeCandidates = vi.fn(async () => ({ hybridCandidateId: "hybrid" }));
    h.acts.mergeCandidates = mergeCandidates;
    h.acts._hybridResult = () => ({
      overallScore: 0.55, // beats seed (0.5) but NOT child1 (0.6) — must beat BOTH
      instanceScores: { 0: 0.55, 1: 0.55 },
      instancesRun: 5,
    });

    // One extra iteration after the merge so a rejected hybrid would show up as a sampled
    // parent if it had (wrongly) been pooled.
    seedRun = vi.fn(async () => baseConfig({ maxIters: DEFAULT_MERGE_EVERY_K_ITERS + 1 }));
    h.acts.seedRun = seedRun;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(mergeCandidates).toHaveBeenCalledTimes(1);
    // The hybrid was scored exactly once (the merge's own full-set eval) — never rolled out
    // again as a parent's minibatch in iteration 6.
    expect(events.filter((e) => e.candidateId === "hybrid")).toEqual([
      { candidateId: "hybrid", phase: PARETO },
    ]);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ bestCandidateId: "child1", overallScore: 0.6 }),
    );
  });

  it("never attempts a merge for a single-Module run", async () => {
    seedRun = vi.fn(async () => baseConfig({ modules: ["only"], maxIters: DEFAULT_MERGE_EVERY_K_ITERS + 1 }));
    h.acts.seedRun = seedRun;
    // A single-Module run's mutation children never beat CHILD1_MINI-shaped fixtures used
    // above; use a fresh generic rollout that always rejects so the loop just runs to maxIters.
    rolloutCandidate = vi.fn(async (input: { candidateId: string; phase: string }) => {
      events.push({ candidateId: input.candidateId, phase: input.phase });
      if (input.phase === PARETO) return SEED_PARETO;
      return LOSING_CHILD_MINI;
    });
    h.acts.rolloutCandidate = rolloutCandidate;
    mergeCandidates = vi.fn(async () => ({ hybridCandidateId: "hybrid" }));
    h.acts.mergeCandidates = mergeCandidates;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(mergeCandidates).not.toHaveBeenCalled();
    expect(events.every((e) => e.candidateId !== "hybrid")).toBe(true);
  });

  it("skips the merge when the remaining budget can't cover a full-set evaluation", async () => {
    // rolloutsUsed after 5 iterations = 60 (5 seed pareto + 15 iter1 accepted-with-follow-up +
    // 4*10 rejected iterations); +instanceCount(5) = 65 > 62, so the merge's own affordability
    // gate must skip it without ever calling mergeCandidates.
    seedRun = vi.fn(async () => baseConfig({ budgetRollouts: 62, maxIters: DEFAULT_MERGE_EVERY_K_ITERS }));
    h.acts.seedRun = seedRun;
    mergeCandidates = vi.fn(async () => ({ hybridCandidateId: "hybrid" }));
    h.acts.mergeCandidates = mergeCandidates;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(mergeCandidates).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ bestCandidateId: "child1", overallScore: 0.6 }),
    );
  });

  it("honors a non-default carried cadence: K=3 merges at iterations 3 and 6, not 5", async () => {
    // Two merge windows in one run: maxIters 6 with K=3 -> attempts after iterations 3 and 6,
    // with successive idempotency keys -1 and -2. The hybrid is rejected each time (beats
    // neither parent), so the pool stays [seed, child1] and the second attempt re-selects the
    // same complementary pair.
    seedRun = vi.fn(async () => baseConfig({ mergeEveryKIters: 3, maxIters: 6 }));
    h.acts.seedRun = seedRun;
    mergeCandidates = vi.fn(async () => ({ hybridCandidateId: "hybrid" }));
    h.acts.mergeCandidates = mergeCandidates;
    h.acts._hybridResult = () => ({
      overallScore: 0.1, // beats neither parent -> rejected, pool unchanged
      instanceScores: { 0: 0.1, 1: 0.1 },
      instancesRun: 5,
    });

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(mergeCandidates).toHaveBeenCalledTimes(2);
    expect(mergeCandidates).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mergeIteration: -1 }), // after iteration 3
    );
    expect(mergeCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mergeIteration: -2 }), // after iteration 6
    );
    // Both hybrids were evaluated on the full set (and rejected).
    expect(events.filter((e) => e.candidateId === "hybrid")).toEqual([
      { candidateId: "hybrid", phase: PARETO },
      { candidateId: "hybrid", phase: PARETO },
    ]);
  });

  it("never attempts a merge when the kill-switch flag is disabled (mergeEnabled: false), even at iteration K", async () => {
    seedRun = vi.fn(async () => baseConfig({ mergeEnabled: false }));
    h.acts.seedRun = seedRun;
    mergeCandidates = vi.fn(async () => ({ hybridCandidateId: "hybrid" }));
    h.acts.mergeCandidates = mergeCandidates;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    // The multi-Module run reached iteration K (maxIters = DEFAULT_MERGE_EVERY_K_ITERS), but the
    // flag carried from seedRun turned the whole merge step off for the run.
    expect(mergeCandidates).not.toHaveBeenCalled();
    expect(events.every((e) => e.candidateId !== "hybrid")).toBe(true);
    expect(completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ bestCandidateId: "child1", overallScore: 0.6 }),
    );
  });
});
