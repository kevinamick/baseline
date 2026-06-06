// Rollout phases, single-sourced (one const list -> derived type) per the enum convention,
// so the value lives in one place instead of as scattered string literals. MINIBATCH is the
// cheap accept/reject test; PARETO is the full frozen set. The list mirrors the
// optimization_rollouts.phase CHECK constraint in the migration — keep the two in sync.
export const MINIBATCH = "minibatch";
export const PARETO = "pareto";

export const ROLLOUT_PHASES = [MINIBATCH, PARETO] as const;
export type RolloutPhase = (typeof ROLLOUT_PHASES)[number];
