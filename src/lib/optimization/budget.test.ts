import { describe, it, expect } from "vitest";
import { iterationCost, minimumViableBudget } from "./budget";
import { shouldContinueLoop } from "../../../worker/src/gepa/circuit-breaker";

// #468 (prod incident opt-4afa3642): a run whose budget can't cover the seed baseline evaluation
// plus at least one iteration burns its whole budget on the seed, then the iteration guard
// refuses to start iteration 1 — the run "completes" with best = seed and zero lift. These tests
// pin the mode-aware minimum-budget formula this module derives, and cross-check it against the
// worker's own `shouldContinueLoop` guard so the two can never silently drift apart.

describe("iterationCost", () => {
  it("Reflective (GEPA): 2 x minibatch, minibatch capped at MINIBATCH_SIZE (5)", () => {
    // instanceCount >= MINIBATCH_SIZE: minibatch saturates at 5.
    expect(iterationCost("reflective", 45)).toBe(10);
    expect(iterationCost("reflective", 5)).toBe(10);
    // instanceCount < MINIBATCH_SIZE: minibatch is the instance count itself.
    expect(iterationCost("reflective", 3)).toBe(6);
    expect(iterationCost("reflective", 1)).toBe(2);
  });

  it("Simple Mode: instanceCount (every candidate scores the full set)", () => {
    expect(iterationCost("simple", 45)).toBe(45);
    expect(iterationCost("simple", 1)).toBe(1);
  });
});

describe("minimumViableBudget", () => {
  it("Reflective: instanceCount + 2 x min(5, instanceCount)", () => {
    // The prod incident's exact shape: 45 instances. Minimum is 45 + 2*5 = 55 (a budget of 10
    // was nowhere close).
    expect(minimumViableBudget("reflective", 45)).toBe(55);
    expect(minimumViableBudget("reflective", 3)).toBe(3 + 6); // minibatch = instanceCount below 5
    expect(minimumViableBudget("reflective", 1)).toBe(1 + 2);
  });

  it("Simple Mode: 2 x instanceCount", () => {
    expect(minimumViableBudget("simple", 45)).toBe(90);
    expect(minimumViableBudget("simple", 1)).toBe(2);
  });

  it("a budget one below the minimum cannot enter iteration 1, for either mode", () => {
    for (const mode of ["reflective", "simple"] as const) {
      for (const instanceCount of [1, 3, 5, 45]) {
        const min = minimumViableBudget(mode, instanceCount);
        const canEnterIteration1 = shouldContinueLoop({
          rolloutsUsed: instanceCount, // the seed's full-set evaluation
          iterationCost: iterationCost(mode, instanceCount),
          budgetRollouts: min - 1,
          iters: 0,
          maxIters: 20,
          plateau: 0,
          plateauPatience: null,
        });
        expect(canEnterIteration1).toBe(false);
      }
    }
  });

  it("a budget at exactly the minimum can still enter iteration 1, for either mode", () => {
    for (const mode of ["reflective", "simple"] as const) {
      for (const instanceCount of [1, 3, 5, 45]) {
        const min = minimumViableBudget(mode, instanceCount);
        const canEnterIteration1 = shouldContinueLoop({
          rolloutsUsed: instanceCount, // the seed's full-set evaluation
          iterationCost: iterationCost(mode, instanceCount),
          budgetRollouts: min,
          iters: 0,
          maxIters: 20,
          plateau: 0,
          plateauPatience: null,
        });
        expect(canEnterIteration1).toBe(true);
      }
    }
  });
});
