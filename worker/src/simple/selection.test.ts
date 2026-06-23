import { describe, it, expect } from "vitest";
import { topK, sampleElite, type ScoredSimpleCandidate } from "./selection.js";

describe("topK", () => {
  const pool: ScoredSimpleCandidate[] = [
    { candidateId: "a", score: 0.4 },
    { candidateId: "b", score: 0.9 },
    { candidateId: "c", score: 0.7 },
    { candidateId: "d", score: 0.1 },
  ];

  it("keeps the highest-scoring k, highest first", () => {
    expect(topK(pool, 2).map((c) => c.candidateId)).toEqual(["b", "c"]);
  });

  it("returns the whole pool sorted when k exceeds its size", () => {
    expect(topK(pool, 10).map((c) => c.candidateId)).toEqual(["b", "c", "a", "d"]);
  });

  it("returns an empty set for k <= 0", () => {
    expect(topK(pool, 0)).toEqual([]);
    expect(topK(pool, -1)).toEqual([]);
  });

  it("breaks ties by incoming order (stable)", () => {
    const tied: ScoredSimpleCandidate[] = [
      { candidateId: "first", score: 0.5 },
      { candidateId: "second", score: 0.5 },
    ];
    expect(topK(tied, 1).map((c) => c.candidateId)).toEqual(["first"]);
  });

  it("does not mutate the input pool", () => {
    const before = pool.map((c) => c.candidateId);
    topK(pool, 2);
    expect(pool.map((c) => c.candidateId)).toEqual(before);
  });
});

describe("sampleElite", () => {
  const elites: ScoredSimpleCandidate[] = [
    { candidateId: "a", score: 0.9 },
    { candidateId: "b", score: 0.8 },
    { candidateId: "c", score: 0.7 },
  ];

  it("picks uniformly by index across the [0,1) range", () => {
    expect(sampleElite(elites, 0)).toBe("a"); // 0 * 3 = 0
    expect(sampleElite(elites, 0.4)).toBe("b"); // 0.4 * 3 = 1.2 -> 1
    expect(sampleElite(elites, 0.7)).toBe("c"); // 0.7 * 3 = 2.1 -> 2
  });

  it("never returns undefined at the top of the range", () => {
    expect(sampleElite(elites, 0.999999)).toBe("c");
  });

  it("returns the sole elite regardless of the draw", () => {
    const single: ScoredSimpleCandidate[] = [{ candidateId: "only", score: 0.5 }];
    expect(sampleElite(single, 0)).toBe("only");
    expect(sampleElite(single, 0.999)).toBe("only");
  });
});
