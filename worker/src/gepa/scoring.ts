// Pure scoring helpers for the GEPA loop — no I/O, so they unit-test without a DB client
// and stay safe to import anywhere. The Activities in activities.ts compose these around
// the agent invoker + judge.

import type { OptimizablePrompt } from "../agent.js";

// The seed prompt map { module: seed } for Candidate 0 — one entry per declared Module.
export function seedPromptsFor(
  optimizablePrompts: OptimizablePrompt[] | null | undefined
): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const mod of optimizablePrompts ?? []) prompts[mod.name] = mod.seed;
  return prompts;
}

// Collapse per-criterion judge scores into one weighted score per instance — the entry a
// Candidate contributes to the Pareto vector. Weighting mirrors evaluateRun's overall score;
// an instance with no results is omitted, and a criterion absent from the rubric weights 0.
export function perInstanceScores(
  results: { rowIndex: number; criterionName: string; score: number }[],
  criteria: { name: string; weight: number }[]
): Record<number, number> {
  const weightOf = new Map(criteria.map((c) => [c.name, c.weight]));
  const byInstance: Record<number, number> = {};
  for (const r of results) {
    byInstance[r.rowIndex] =
      (byInstance[r.rowIndex] ?? 0) + (weightOf.get(r.criterionName) ?? 0) * r.score;
  }
  return byInstance;
}
