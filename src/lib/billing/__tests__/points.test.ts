import { describe, it, expect } from "vitest";
import {
  EVAL_POINTS_BASE_PER_ROW,
  EVAL_POINTS_PER_CRITERION,
  evalRunPointCost,
  evalRunPointsPerRow,
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
