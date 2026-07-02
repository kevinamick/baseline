import { describe, it, expect, vi, afterEach } from "vitest";
import type { Rubric } from "./evaluator.js";
import type { LLMProvider, LLMJudgeResult } from "./providers/llm.js";

// EVAL_JUDGE_CONCURRENCY is read once, at module load, into the JUDGE_CONCURRENCY const in
// evaluator.ts. To exercise a given value we set the env var, then re-import a fresh copy of
// the module with vi.resetModules() so the module-load read picks up our value.
async function loadEvaluate() {
  vi.resetModules();
  return (await import("./evaluator.js")).evaluateRun;
}

const baseRubric: Rubric = {
  name: "Helpfulness",
  scenario_description: "User asks a support question.",
  expected_outcome: "A correct, on-topic answer.",
  grounding_context: null,
  criteria: [
    { name: "a", weight: 0.5, steps: ["x"] },
    { name: "b", weight: 0.5, steps: ["y"] },
  ],
};

// 3 rows × 2 criteria = 6 independent (row × criterion) judge tasks — enough to saturate any
// small cap so the observed peak equals the cap rather than the task count.
const rows = [0, 1, 2].map((i) => ({
  row_index: i,
  user_input: `row-${i}`,
  agent_output: "out",
  expected_output: null,
  retrieval_context: null,
}));

// A judge that parks every call until released, letting us watch how many run at once. Returns
// the peak concurrency observed across the whole run.
async function peakConcurrency(
  evaluateRun: (typeof import("./evaluator.js"))["evaluateRun"],
): Promise<number> {
  let inFlight = 0;
  let maxInFlight = 0;
  const release: Array<() => void> = [];
  const provider = {
    async judge(): Promise<LLMJudgeResult> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return { score: 0.5, reasoning: "" };
    },
  } as unknown as LLMProvider;

  const promise = evaluateRun(baseRubric, rows, provider, "tabular");
  // Drain until all 6 judge tasks have settled. Release every currently-parked call, then yield a
  // full macrotask so the concurrency runners can pull and park the next batch before we look again.
  while (release.length > 0 || inFlight > 0) {
    while (release.length > 0) release.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await promise;
  return maxInFlight;
}

describe("EVAL_JUDGE_CONCURRENCY caps the judge fan-out", () => {
  const original = process.env.EVAL_JUDGE_CONCURRENCY;
  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_JUDGE_CONCURRENCY;
    else process.env.EVAL_JUDGE_CONCURRENCY = original;
  });

  it("caps concurrent judge calls at EVAL_JUDGE_CONCURRENCY=2", async () => {
    process.env.EVAL_JUDGE_CONCURRENCY = "2";
    const evaluateRun = await loadEvaluate();
    expect(await peakConcurrency(evaluateRun)).toBe(2);
  });

  it("caps concurrent judge calls at EVAL_JUDGE_CONCURRENCY=3", async () => {
    process.env.EVAL_JUDGE_CONCURRENCY = "3";
    const evaluateRun = await loadEvaluate();
    expect(await peakConcurrency(evaluateRun)).toBe(3);
  });

  it("defaults to 5 when the env var is unset", async () => {
    delete process.env.EVAL_JUDGE_CONCURRENCY;
    const evaluateRun = await loadEvaluate();
    // 6 tasks, cap 5 → peak 5.
    expect(await peakConcurrency(evaluateRun)).toBe(5);
  });

  it("falls back to 5 on a non-positive or unparseable value", async () => {
    for (const bad of ["0", "-3", "abc", ""]) {
      process.env.EVAL_JUDGE_CONCURRENCY = bad;
      const evaluateRun = await loadEvaluate();
      expect(await peakConcurrency(evaluateRun)).toBe(5);
    }
  });
});
