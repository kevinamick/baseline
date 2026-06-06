import { describe, it, expect } from "vitest";
import {
  accepts,
  improvesFrontier,
  instanceMaxima,
  paretoFrontier,
  sampleParent,
  winCounts,
  type ScoredCandidate,
} from "./pareto.js";

describe("instanceMaxima", () => {
  it("takes the best score per instance across the pool", () => {
    const pool: ScoredCandidate[] = [
      { candidateId: "a", instanceScores: { 0: 0.2, 1: 0.9 } },
      { candidateId: "b", instanceScores: { 0: 0.8, 1: 0.1 } },
    ];
    expect(instanceMaxima(pool)).toEqual({ 0: 0.8, 1: 0.9 });
  });
});

describe("winCounts / paretoFrontier", () => {
  it("counts a win per instance a candidate is best on", () => {
    const pool: ScoredCandidate[] = [
      // a wins instance 1; b wins instance 0 — complementary winners, both on the frontier.
      { candidateId: "a", instanceScores: { 0: 0.2, 1: 0.9 } },
      { candidateId: "b", instanceScores: { 0: 0.8, 1: 0.1 } },
    ];
    const wins = winCounts(pool);
    expect(wins.get("a")).toBe(1);
    expect(wins.get("b")).toBe(1);
    expect(paretoFrontier(pool).sort()).toEqual(["a", "b"]);
  });

  it("gives a tie on an instance to every tied candidate", () => {
    const pool: ScoredCandidate[] = [
      { candidateId: "a", instanceScores: { 0: 0.5, 1: 0.5 } },
      { candidateId: "b", instanceScores: { 0: 0.5, 1: 0.3 } },
    ];
    const wins = winCounts(pool);
    expect(wins.get("a")).toBe(2); // ties instance 0, wins instance 1
    expect(wins.get("b")).toBe(1); // ties instance 0 only
  });

  it("treats scores within epsilon as tied", () => {
    const pool: ScoredCandidate[] = [
      { candidateId: "a", instanceScores: { 0: 0.7 } },
      { candidateId: "b", instanceScores: { 0: 0.7 + 1e-12 } },
    ];
    expect(winCounts(pool).get("a")).toBe(1);
    expect(winCounts(pool).get("b")).toBe(1);
  });

  it("excludes a fully dominated candidate from the frontier", () => {
    const pool: ScoredCandidate[] = [
      { candidateId: "winner", instanceScores: { 0: 0.9, 1: 0.9 } },
      { candidateId: "dominated", instanceScores: { 0: 0.1, 1: 0.2 } },
    ];
    expect(paretoFrontier(pool)).toEqual(["winner"]);
  });
});

describe("sampleParent", () => {
  // a wins 3 instances, b wins 1 -> weights 3:1 over the [0,1) draw.
  const pool: ScoredCandidate[] = [
    { candidateId: "a", instanceScores: { 0: 0.9, 1: 0.9, 2: 0.9, 3: 0.1 } },
    { candidateId: "b", instanceScores: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.9 } },
  ];

  it("draws the heavier winner across most of the range", () => {
    expect(sampleParent(pool, 0)).toBe("a");
    expect(sampleParent(pool, 0.74)).toBe("a"); // 0.74 * 4 = 2.96 < 3
    expect(sampleParent(pool, 0.76)).toBe("b"); // 0.76 * 4 = 3.04 >= 3
  });

  it("never returns undefined at the top of the range", () => {
    expect(sampleParent(pool, 0.999999)).toBe("b");
  });

  it("returns the sole candidate regardless of the draw", () => {
    const single: ScoredCandidate[] = [{ candidateId: "only", instanceScores: { 0: 0.5 } }];
    expect(sampleParent(single, 0)).toBe("only");
    expect(sampleParent(single, 0.999)).toBe("only");
  });

  it("falls back to the last pool member when no candidate has scores", () => {
    const noScores: ScoredCandidate[] = [
      { candidateId: "x", instanceScores: {} },
      { candidateId: "y", instanceScores: {} },
    ];
    expect(sampleParent(noScores, 0.5)).toBe("y");
  });
});

describe("accepts", () => {
  it("accepts a strict improvement and rejects ties / regressions", () => {
    expect(accepts(0.81, 0.8)).toBe(true);
    expect(accepts(0.8, 0.8)).toBe(false);
    expect(accepts(0.79, 0.8)).toBe(false);
  });
});

describe("improvesFrontier", () => {
  // Each instance score is compared to the pool's best on THAT instance (maxima), never to the
  // candidate's other instances. Winning even one instance is a frontier gain — that's what
  // keeps a specialist (great on instance 0, weak elsewhere) on the frontier.
  const maxima = { 0: 0.8, 1: 0.9 };

  it("is true when the candidate beats the max on any single instance", () => {
    // 0.85 > maxima[0]=0.8 wins instance 0; the weak 0.5 on instance 1 is irrelevant.
    expect(improvesFrontier(maxima, { candidateId: "c", instanceScores: { 0: 0.85, 1: 0.5 } })).toBe(true);
  });

  it("is true when the candidate covers an instance the pool hadn't (any score)", () => {
    // instance 2 isn't in maxima, so any score there is a brand-new frontier point.
    expect(improvesFrontier(maxima, { candidateId: "c", instanceScores: { 2: 0.1 } })).toBe(true);
  });

  it("is false when the candidate ties/loses every instance vs the maxima", () => {
    // 0.8 == maxima[0] (a tie is not a gain) and 0.7 < maxima[1]=0.9, so it expands nothing.
    expect(improvesFrontier(maxima, { candidateId: "c", instanceScores: { 0: 0.8, 1: 0.7 } })).toBe(false);
  });
});
