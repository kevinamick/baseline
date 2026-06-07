// Read-side reproduction of the worker evaluator's `overallScore` (see
// worker/src/evaluator.ts): per-criterion average across instances, weighted by the rubric.
// RubricSchema forces the weights to sum to 1, so the result is in [0, 1].
//
// We need this on the Next tier because only the *winning* Candidate's score is persisted
// (optimization_runs.best_score). The seed Candidate's overall score — the lift baseline a
// completed run shows ("0.62 → 0.81") — is not stored, so it must be recomputed from the
// seed's Pareto rollout_results. Kept pure so it unit-tests without a DB client.

export interface ScoredCriterion {
  name: string;
  weight: number;
}

export interface CriterionResult {
  criterion_name: string;
  score: number;
}

export function overallScoreFromResults(
  criteria: ScoredCriterion[],
  results: CriterionResult[]
): number {
  return criteria.reduce((total, criterion) => {
    const forCriterion = results.filter((r) => r.criterion_name === criterion.name);
    if (forCriterion.length === 0) return total;
    const avg = forCriterion.reduce((sum, r) => sum + r.score, 0) / forCriterion.length;
    return total + criterion.weight * avg;
  }, 0);
}

// A meaningful improvement of `best` over `seed`. Tolerates float dust so a winner that merely
// re-derives the seed score doesn't read as a (misleading) lift. Either score being null means
// we can't claim a lift.
const LIFT_EPSILON = 1e-4;

export function hasLift(seedScore: number | null, bestScore: number | null): boolean {
  if (seedScore == null || bestScore == null) return false;
  return bestScore - seedScore > LIFT_EPSILON;
}
