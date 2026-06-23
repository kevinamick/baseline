// Rollout phases, single-sourced (one const list -> derived type) per the enum convention,
// so the value lives in one place instead of as scattered string literals. MINIBATCH is the
// cheap accept/reject test and PARETO the full frozen set, both GEPA. FULL is Simple Mode's
// full-set scoring (ADR-0015): it has no accept/reject step, so every Candidate is scored
// once on the whole set. The list mirrors the optimization_rollouts.phase CHECK constraint
// in the migration — keep the two in sync.
export const MINIBATCH = "minibatch";
export const PARETO = "pareto";
export const FULL = "full";

export const ROLLOUT_PHASES = [MINIBATCH, PARETO, FULL] as const;
export type RolloutPhase = (typeof ROLLOUT_PHASES)[number];
