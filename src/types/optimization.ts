// Single-sourced Optimization Run status set (mirrors the optimization_run_status
// Postgres enum). One const list → derived type, never a duplicated union.
export const OPTIMIZATION_RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type OptimizationRunStatus = (typeof OPTIMIZATION_RUN_STATUSES)[number];

// A run's non-terminal states — still holding the org's single active slot.
export const ACTIVE_OPTIMIZATION_STATUSES: OptimizationRunStatus[] = ["queued", "running"];

export function isActiveOptimizationStatus(status: OptimizationRunStatus): boolean {
  return ACTIVE_OPTIMIZATION_STATUSES.includes(status);
}

// List-row shape for the Optimizations surface. A run has no name of its own, so the
// list identifies it by its agent Connection name + relative start time (created_at).
export interface OptimizationRunSummary {
  id: string;
  connection_name: string;
  rubric_name: string;
  status: OptimizationRunStatus;
  best_score: number | null;
  created_at: string;
}
