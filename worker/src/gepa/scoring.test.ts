import { describe, it, expect } from "vitest";
import { perInstanceScores, seedPromptsFor } from "./scoring.js";

describe("seedPromptsFor", () => {
  it("maps each declared Module to its seed", () => {
    expect(
      seedPromptsFor([
        { name: "system", seed: "You are helpful." },
        { name: "style", seed: "Be terse." },
      ])
    ).toEqual({ system: "You are helpful.", style: "Be terse." });
  });

  it("returns an empty map for null / undefined / no Modules", () => {
    expect(seedPromptsFor(null)).toEqual({});
    expect(seedPromptsFor(undefined)).toEqual({});
    expect(seedPromptsFor([])).toEqual({});
  });
});

describe("perInstanceScores", () => {
  const criteria = [
    { name: "accuracy", weight: 0.7 },
    { name: "tone", weight: 0.3 },
  ];

  it("weights criteria per instance", () => {
    const results = [
      { rowIndex: 0, criterionName: "accuracy", score: 1.0 },
      { rowIndex: 0, criterionName: "tone", score: 0.0 },
      { rowIndex: 1, criterionName: "accuracy", score: 0.5 },
      { rowIndex: 1, criterionName: "tone", score: 1.0 },
    ];
    const scores = perInstanceScores(results, criteria);
    expect(scores[0]).toBeCloseTo(0.7);
    expect(scores[1]).toBeCloseTo(0.65);
  });

  it("omits instances with no results", () => {
    const scores = perInstanceScores(
      [{ rowIndex: 2, criterionName: "accuracy", score: 1 }],
      criteria
    );
    expect(scores).toEqual({ 2: 0.7 });
    expect(0 in scores).toBe(false);
  });

  it("treats a criterion absent from the rubric weights as zero", () => {
    const scores = perInstanceScores(
      [{ rowIndex: 0, criterionName: "unknown", score: 1 }],
      criteria
    );
    expect(scores[0]).toBe(0);
  });
});
