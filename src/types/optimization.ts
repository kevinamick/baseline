// Single-sourced Optimization Run status set (mirrors the optimization_run_status
// Postgres enum). One const list → derived type, never a duplicated union.
export const OPTIMIZATION_RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type OptimizationRunStatus = (typeof OPTIMIZATION_RUN_STATUSES)[number];

// A run's non-terminal states — still holding the org's single active slot.
export const ACTIVE_OPTIMIZATION_STATUSES: OptimizationRunStatus[] = ["queued", "running"];

export function isActiveOptimizationStatus(status: OptimizationRunStatus): boolean {
  return ACTIVE_OPTIMIZATION_STATUSES.includes(status);
}

// An agent Connection eligible for optimization: it declares ≥1 {{prompt:*}} Module. The
// start wizard's System step lists these (a Connection with no Modules has nothing to tune).
export interface OptimizableConnection {
  id: string;
  name: string;
  modules: string[];
}

// One editable instance row in the start wizard (UI shape: every field a string, blanks for
// the optional columns). Cleaned to the schema's userInput/expectedOutput/retrievalContext at
// submit. Shared by the manual editor and the CSV/JSON parsers.
export interface OptimizationInstanceRow {
  userInput: string;
  expectedOutput: string;
  retrievalContext: string;
}

// List-row shape for the Optimizations surface. A run has no name of its own, so the
// list identifies it by its agent Connection name + relative start time (created_at).
export interface OptimizationRunSummary {
  id: string;
  connection_name: string;
  rubric_name: string;
  status: OptimizationRunStatus;
  best_score: number | null;
  // The seed Candidate's overall score, recomputed from its Pareto rollouts (completed runs
  // only; null otherwise). Pairs with best_score to show the score lift on the list row.
  seed_score: number | null;
  created_at: string;
}
