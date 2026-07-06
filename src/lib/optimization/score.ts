// The seed → best score lift shown on a completed Optimization Run. Both scores are persisted
// on optimization_runs at the completion transition (best_score always was; seed_score joined it
// in #113 — see worker/src/gepa/activities.ts's completeRun) using the worker evaluator's own
// `overallScore` weighting (worker/src/evaluator.ts), so this file no longer reproduces that
// formula: the read surface (src/app/actions/optimizations.ts) reads the stored columns directly
// rather than recomputing from rollout_results, which used to drift from the worker's weighting
// and broke on post-run rubric edits.

// A meaningful improvement of `best` over `seed`. Tolerates float dust so a winner that merely
// re-derives the seed score doesn't read as a (misleading) lift. Either score being null means
// we can't claim a lift.
const LIFT_EPSILON = 1e-4;

export function hasLift(seedScore: number | null, bestScore: number | null): boolean {
  if (seedScore == null || bestScore == null) return false;
  return bestScore - seedScore > LIFT_EPSILON;
}
