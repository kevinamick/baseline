// Single-sourced Optimization Run status set (mirrors the optimization_run_status
// Postgres enum). One const list → derived type, never a duplicated union.
export const OPTIMIZATION_RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type OptimizationRunStatus = (typeof OPTIMIZATION_RUN_STATUSES)[number];

// A run's non-terminal states — still holding the org's single active slot.
export const ACTIVE_OPTIMIZATION_STATUSES: OptimizationRunStatus[] = ["queued", "running"];

export function isActiveOptimizationStatus(status: OptimizationRunStatus): boolean {
  return ACTIVE_OPTIMIZATION_STATUSES.includes(status);
}

// How a run searches for a better prompt (mirrors the optimization_runs.mode CHECK).
// 'reflective' is the GEPA loop that learns from natural-language feedback; 'simple' is
// the score-only Monte Carlo search, available only on paste-a-prompt Managed Agents.
// See ADR-0015 and CONTEXT.md. One const list → derived type, never a duplicated union.
export const OPTIMIZATION_MODES = ["simple", "reflective"] as const;
export type OptimizationMode = (typeof OPTIMIZATION_MODES)[number];

export function isOptimizationMode(value: unknown): value is OptimizationMode {
  return typeof value === "string" && (OPTIMIZATION_MODES as readonly string[]).includes(value);
}

// An agent Connection eligible for optimization: it declares ≥1 {{prompt:*}} Module. The
// start wizard's System step lists these (a Connection with no Modules has nothing to tune).
export interface OptimizableConnection {
  id: string;
  name: string;
  modules: string[];
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
