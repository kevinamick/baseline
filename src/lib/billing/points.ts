/**
 * Eval Point cost model (#180, ADR-0008/0009). The constants are pricing knobs:
 * code, not config, so a price change is a reviewed PR — same rule as plans.ts.
 *
 * An Eval Run's cost is exact and known at creation:
 *
 *   cost = rows × (base + perCriterion × |criteria|)
 *
 * This file is importable from client components (the run dialog shows the
 * exact cost before a run starts), so it must stay free of server imports.
 */

/** Orchestration cost per input row, before any criterion is scored. */
export const EVAL_POINTS_BASE_PER_ROW = 10;

/** Scoring cost per criterion, per row. */
export const EVAL_POINTS_PER_CRITERION = 5;

/** The per-row cost for a rubric with `criteriaCount` criteria. */
export function evalRunPointsPerRow(criteriaCount: number): number {
  return EVAL_POINTS_BASE_PER_ROW + EVAL_POINTS_PER_CRITERION * criteriaCount;
}

/** The exact, total Eval Point cost of a run. */
export function evalRunPointCost(rowCount: number, criteriaCount: number): number {
  return rowCount * evalRunPointsPerRow(criteriaCount);
}
