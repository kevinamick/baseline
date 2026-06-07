import { describe, it, expect } from "vitest";
import { overallScoreFromResults, hasLift } from "./score";

describe("overallScoreFromResults", () => {
  const criteria = [
    { name: "accuracy", weight: 0.6 },
    { name: "tone", weight: 0.4 },
  ];

  it("weights each criterion's average across instances (mirrors evaluateRun)", () => {
    // accuracy: avg(1.0, 0.5) = 0.75 ; tone: avg(0.0, 1.0) = 0.5
    // overall = 0.6*0.75 + 0.4*0.5 = 0.45 + 0.2 = 0.65
    const results = [
      { criterion_name: "accuracy", score: 1.0 },
      { criterion_name: "accuracy", score: 0.5 },
      { criterion_name: "tone", score: 0.0 },
      { criterion_name: "tone", score: 1.0 },
    ];
    expect(overallScoreFromResults(criteria, results)).toBeCloseTo(0.65);
  });

  it("skips a criterion with no results rather than counting it as zero", () => {
    // Only accuracy has results (avg 1.0). tone contributes nothing — not a 0 that would
    // drag the weighted total down.
    const results = [{ criterion_name: "accuracy", score: 1.0 }];
    expect(overallScoreFromResults(criteria, results)).toBeCloseTo(0.6);
  });

  it("returns 0 when there are no results at all", () => {
    expect(overallScoreFromResults(criteria, [])).toBe(0);
  });

  it("ignores results for criteria not in the rubric", () => {
    const results = [{ criterion_name: "ghost", score: 1.0 }];
    expect(overallScoreFromResults(criteria, results)).toBe(0);
  });
});

describe("hasLift", () => {
  it("is true only when best meaningfully exceeds seed", () => {
    expect(hasLift(0.62, 0.81)).toBe(true);
  });

  it("is false when the winner merely re-derives the seed score", () => {
    expect(hasLift(0.81, 0.81)).toBe(false);
    expect(hasLift(0.81, 0.810001)).toBe(false);
  });

  it("is false when best is below seed", () => {
    expect(hasLift(0.81, 0.62)).toBe(false);
  });

  it("is false when either score is unknown", () => {
    expect(hasLift(null, 0.81)).toBe(false);
    expect(hasLift(0.62, null)).toBe(false);
  });
});
