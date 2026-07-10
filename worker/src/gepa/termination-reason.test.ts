import { describe, it, expect } from "vitest";
import { deriveTerminationReason, isTerminationReason, TERMINATION_REASONS } from "./termination-reason.js";

describe("deriveTerminationReason (#469)", () => {
  it("returns no_modules when the Connection has no optimizable Modules", () => {
    expect(
      deriveTerminationReason({ modulesCount: 0, instanceCount: 5, loopIterations: 0 }),
    ).toBe("no_modules");
  });

  it("returns no_modules over no_instances when both are degenerate", () => {
    expect(
      deriveTerminationReason({ modulesCount: 0, instanceCount: 0, loopIterations: 0 }),
    ).toBe("no_modules");
  });

  it("returns no_instances when the frozen Instance set is empty", () => {
    expect(
      deriveTerminationReason({ modulesCount: 1, instanceCount: 0, loopIterations: 0 }),
    ).toBe("no_instances");
  });

  it("returns budget_exhausted_by_baseline when the loop could have run but never entered iteration 1", () => {
    expect(
      deriveTerminationReason({ modulesCount: 1, instanceCount: 5, loopIterations: 0 }),
    ).toBe("budget_exhausted_by_baseline");
  });

  it("returns null once at least one iteration ran, regardless of why the loop then stopped", () => {
    expect(
      deriveTerminationReason({ modulesCount: 1, instanceCount: 5, loopIterations: 1 }),
    ).toBeNull();
    expect(
      deriveTerminationReason({ modulesCount: 2, instanceCount: 10, loopIterations: 50 }),
    ).toBeNull();
  });
});

describe("isTerminationReason", () => {
  it("accepts every code in TERMINATION_REASONS", () => {
    for (const reason of TERMINATION_REASONS) {
      expect(isTerminationReason(reason)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isTerminationReason("something_else")).toBe(false);
    expect(isTerminationReason(null)).toBe(false);
    expect(isTerminationReason(undefined)).toBe(false);
    expect(isTerminationReason(42)).toBe(false);
  });
});
