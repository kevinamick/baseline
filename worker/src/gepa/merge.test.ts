import { describe, it, expect } from "vitest";
import {
  beatsBothParents,
  combineModulePrompts,
  DEFAULT_MERGE_EVERY_K_ITERS,
  resolveMergeEveryKIters,
  selectComplementaryPair,
  type CandidateWithPrompts,
} from "./merge.js";
import type { ScoredCandidate } from "./pareto.js";

describe("selectComplementaryPair", () => {
  it("picks two frontier lineages that each win instances the other loses", () => {
    const pool: ScoredCandidate[] = [
      { candidateId: "a", instanceScores: { 0: 0.9, 1: 0.2 } },
      { candidateId: "b", instanceScores: { 0: 0.1, 1: 0.9 } },
    ];
    expect(selectComplementaryPair(pool)).toEqual({ aId: "a", bId: "b" });
  });

  it("prefers the two highest win-count frontier members when several pairs are complementary", () => {
    const pool: ScoredCandidate[] = [
      // a wins instances 0,1,2 (3 wins); b wins instance 3 (1 win); c wins instance 4 (1 win).
      { candidateId: "a", instanceScores: { 0: 0.9, 1: 0.9, 2: 0.9, 3: 0.1, 4: 0.1 } },
      { candidateId: "b", instanceScores: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.9, 4: 0.1 } },
      { candidateId: "c", instanceScores: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.9 } },
    ];
    // a (3 wins) pairs with the next-highest, b (1 win) — both complementary — before c is
    // ever considered.
    expect(selectComplementaryPair(pool)).toEqual({ aId: "a", bId: "b" });
  });

  it("returns null when the frontier has fewer than two winners", () => {
    const pool: ScoredCandidate[] = [
      { candidateId: "solo", instanceScores: { 0: 0.9, 1: 0.9 } },
    ];
    expect(selectComplementaryPair(pool)).toBeNull();
  });

  it("returns null when one candidate's wins are a strict subset of the other's (no complementary pair)", () => {
    const pool: ScoredCandidate[] = [
      // b ties a on instance 0 (both win it) but a alone wins instance 1 — b has no win a
      // lacks, so the pair isn't complementary (merging would just reproduce a).
      { candidateId: "a", instanceScores: { 0: 0.9, 1: 0.9 } },
      { candidateId: "b", instanceScores: { 0: 0.9, 1: 0.1 } },
    ];
    expect(selectComplementaryPair(pool)).toBeNull();
  });

  it("returns null for an empty pool", () => {
    expect(selectComplementaryPair([])).toBeNull();
  });
});

describe("combineModulePrompts", () => {
  const a: CandidateWithPrompts = {
    candidateId: "a",
    overallScore: 0.8,
    prompts: { classifier: "A-classifier", responder: "A-responder", style: "A-style" },
  };
  const b: CandidateWithPrompts = {
    candidateId: "b",
    overallScore: 0.6,
    prompts: { classifier: "B-classifier", responder: "B-responder", style: "B-style" },
  };

  it("round-robins Modules starting with the higher-overall-score parent", () => {
    const result = combineModulePrompts(a, b, ["classifier", "responder", "style"]);
    expect(result.prompts).toEqual({
      classifier: "A-classifier", // index 0 -> stronger parent (a)
      responder: "B-responder", // index 1 -> weaker parent (b)
      style: "A-style", // index 2 -> stronger parent (a) again
    });
    expect(result.primaryParentId).toBe("a");
    expect(result.secondaryParentId).toBe("b");
  });

  it("is symmetric in argument order (b, a) — same combination either way", () => {
    const result = combineModulePrompts(b, a, ["classifier", "responder", "style"]);
    expect(result.prompts).toEqual({
      classifier: "A-classifier",
      responder: "B-responder",
      style: "A-style",
    });
    expect(result.primaryParentId).toBe("a");
  });

  it("breaks an exact overall-score tie by candidateId, deterministically", () => {
    const tiedA: CandidateWithPrompts = { ...a, overallScore: 0.7, candidateId: "aaa" };
    const tiedB: CandidateWithPrompts = { ...b, overallScore: 0.7, candidateId: "bbb" };
    const result = combineModulePrompts(tiedA, tiedB, ["classifier", "responder"]);
    // "aaa" < "bbb" lexicographically -> aaa goes first regardless of argument order.
    expect(result.primaryParentId).toBe("aaa");

    const flipped = combineModulePrompts(tiedB, tiedA, ["classifier", "responder"]);
    expect(flipped.primaryParentId).toBe("aaa");
    expect(flipped.prompts).toEqual(result.prompts);
  });

  it("defaults a missing Module prompt to an empty string rather than throwing", () => {
    const sparse: CandidateWithPrompts = { candidateId: "s", overallScore: 0.5, prompts: {} };
    const result = combineModulePrompts(a, sparse, ["classifier", "missing"]);
    expect(result.prompts.classifier).toBe("A-classifier");
    expect(result.prompts.missing).toBe("");
  });
});

describe("resolveMergeEveryKIters", () => {
  it("defaults when the env var is unset", () => {
    expect(resolveMergeEveryKIters(undefined)).toBe(DEFAULT_MERGE_EVERY_K_ITERS);
  });

  it("accepts a positive integer", () => {
    expect(resolveMergeEveryKIters("3")).toBe(3);
    expect(resolveMergeEveryKIters("1")).toBe(1); // 1 = merge after every iteration
  });

  it("falls back to the default on zero, negative, or non-numeric values", () => {
    expect(resolveMergeEveryKIters("0")).toBe(DEFAULT_MERGE_EVERY_K_ITERS);
    expect(resolveMergeEveryKIters("-2")).toBe(DEFAULT_MERGE_EVERY_K_ITERS);
    expect(resolveMergeEveryKIters("abc")).toBe(DEFAULT_MERGE_EVERY_K_ITERS);
    expect(resolveMergeEveryKIters("")).toBe(DEFAULT_MERGE_EVERY_K_ITERS);
  });
});

describe("beatsBothParents", () => {
  const a: CandidateWithPrompts = { candidateId: "a", overallScore: 0.7, prompts: {} };
  const b: CandidateWithPrompts = { candidateId: "b", overallScore: 0.6, prompts: {} };

  it("keeps the hybrid only when it strictly beats both parents", () => {
    expect(beatsBothParents(0.71, a, b)).toBe(true);
  });

  it("rejects a hybrid that ties one parent", () => {
    expect(beatsBothParents(0.7, a, b)).toBe(false);
  });

  it("rejects a hybrid that beats only the weaker parent", () => {
    expect(beatsBothParents(0.65, a, b)).toBe(false);
  });

  it("rejects a hybrid that beats neither parent", () => {
    expect(beatsBothParents(0.5, a, b)).toBe(false);
  });
});
