// Single-sourced Optimization Run status set (mirrors the optimization_run_status
// Postgres enum). One const list → derived type, never a duplicated union.
export const OPTIMIZATION_RUN_STATUSES = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
] as const;
export type OptimizationRunStatus = (typeof OPTIMIZATION_RUN_STATUSES)[number];

// A run's non-terminal states — still holding the org's single active slot. A paused run
// (#102: waiting out an endpoint outage) deliberately keeps the slot: the in-flight
// optimization survives the outage instead of fail-fast freeing the slot.
export const ACTIVE_OPTIMIZATION_STATUSES: OptimizationRunStatus[] = [
  "queued",
  "running",
  "paused",
];

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

// A dataset Connection the Instances step can snapshot rows from as a fourth intake source
// (#82), alongside manual/CSV/JSON. Minimal by design: the wizard only needs enough to label
// the picker — the real Connection row (endpoint, decrypted credential, field map) is resolved
// server-side, at run start, and never reaches the browser.
export interface DatasetConnectionOption {
  id: string;
  name: string;
}

// An existing Eval Run the Instances step can seed rows from as a further intake source (#83),
// alongside manual/CSV/JSON and the dataset-Connection snapshot (#82). Minimal by design — the
// wizard only needs enough to label the picker (description/date/row count); the actual rows
// are resolved server-side, at run start, and never reach the browser twice. `description` is
// nullable (an Eval Run has no required name) and `rowCount` is the run's TOTAL row count —
// which can exceed MAX_OPTIMIZATION_INSTANCES, in which case the run seeds only its first 50
// rows by row_index.
export interface EvalRunInstanceOption {
  id: string;
  description: string | null;
  createdAt: string;
  rowCount: number;
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
