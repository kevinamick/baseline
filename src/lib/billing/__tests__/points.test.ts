import { describe, it, expect } from "vitest";
import {
  EVAL_POINTS_BASE_PER_ROW,
  EVAL_POINTS_PER_CRITERION,
  evalRunPointCost,
  evalRunPointsPerRow,
  optimizationRunPointCost,
} from "../points";

describe("evalRunPointsPerRow", () => {
  it("is the base cost for a rubric with no criteria", () => {
    expect(evalRunPointsPerRow(0)).toBe(EVAL_POINTS_BASE_PER_ROW);
  });

  it("adds the per-criterion cost once per criterion", () => {
    expect(evalRunPointsPerRow(4)).toBe(
      EVAL_POINTS_BASE_PER_ROW + 4 * EVAL_POINTS_PER_CRITERION
    );
  });
});

describe("evalRunPointCost", () => {
  it("is rows × per-row cost", () => {
    expect(evalRunPointCost(20, 3)).toBe(20 * evalRunPointsPerRow(3));
  });

  it("is zero for zero rows", () => {
    expect(evalRunPointCost(0, 5)).toBe(0);
  });

  it("matches the documented formula Σ rows × (base + perCriterion × |criteria|)", () => {
    // The exact shape #180 specifies, spelled out rather than via the helpers.
    const rows = 7;
    const criteria = 5;
    expect(evalRunPointCost(rows, criteria)).toBe(
      rows * (EVAL_POINTS_BASE_PER_ROW + EVAL_POINTS_PER_CRITERION * criteria)
    );
  });
});

describe("optimizationRunPointCost (ADR-0016)", () => {
  it("is scored rollouts × per-rollout cost — the same per-unit cost as an eval row", () => {
    // A scored rollout is one instance judged across all criteria, so it costs
    // exactly what one eval row costs.
    expect(optimizationRunPointCost(20, 2)).toBe(20 * evalRunPointsPerRow(2));
    expect(optimizationRunPointCost(20, 2)).toBe(evalRunPointCost(20, 2));
  });

  it("worst-case (budget_rollouts) and settle (scored) use one formula", () => {
    const criteria = 3;
    const perRollout = EVAL_POINTS_BASE_PER_ROW + EVAL_POINTS_PER_CRITERION * criteria;
    expect(optimizationRunPointCost(200, criteria)).toBe(200 * perRollout); // reserve ceiling
    expect(optimizationRunPointCost(37, criteria)).toBe(37 * perRollout); // actual scored
  });

  it("is zero when no rollouts are scored", () => {
    expect(optimizationRunPointCost(0, 5)).toBe(0);
  });
});
