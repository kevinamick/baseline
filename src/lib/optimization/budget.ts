// The rollout-budget floor an Optimization Run needs to survive its own seed baseline evaluation
// AND still afford one iteration afterward (#468, prod incident opt-4afa3642): a 45-instance run
// with a budget of 10 burned every rollout scoring the seed, then the iteration guard refused to
// start iteration 1 — the run "completed" with best = seed and zero lift. Every budget smaller
// than the instance count produces this for ANY instance source (inline paste, dataset snapshot,
// eval-run copy), since all three are resolved into a frozen, exact-length instance set by
// `startOptimizationRun` (`src/app/actions/optimizations.ts`) before the run row — and this
// budget check — exist. No estimation needed.
//
// This module is imported by BOTH the server action (the authoritative refusal) and the wizard
// (`optimization-wizard.tsx`, a Client Component — the live instance-count/minimum-budget hint
// next to the budget field). It has no server-only dependency, so it's safe in either bundle.
//
// The minimum is MODE-AWARE, not a single formula for both Modes:
//   - Reflective (GEPA, `worker/src/gepa/workflow.ts`): one iteration tests a parent+child pair
//     on a minibatch AND full-set-validates an accepted child before pooling it, so its cost is
//     `reflectiveIterationCost(instanceCount)` — imported (not copied) from the worker's
//     `circuit-breaker.ts`, the same module the workflow's own `shouldContinueLoop` guard reads,
//     so the wizard's floor and the worker's guard can never drift apart. That module is
//     deliberately import-free and therefore safely app-reachable (see its comment) — importing
//     gepa/workflow.ts itself is NOT an option, since it pulls in `@temporalio/workflow` and
//     must never enter the Next app bundle.
//   - Simple Mode (`worker/src/simple/workflow.ts`): every candidate is scored on the FULL
//     instance set, so one iteration costs `instanceCount` — see that workflow's own
//     `shouldContinueLoop` call (`iterationCost: instanceCount`).
import { reflectiveIterationCost } from "../../../worker/src/gepa/circuit-breaker";
import type { OptimizationMode } from "@/types/optimization";

// One iteration's guaranteed rollout cost for the given Mode, mirroring the exact `iterationCost`
// each worker workflow passes into `shouldContinueLoop` (`worker/src/gepa/circuit-breaker.ts`).
export function iterationCost(mode: OptimizationMode, instanceCount: number): number {
  return mode === "simple" ? instanceCount : reflectiveIterationCost(instanceCount);
}

// The minimum viable `budget_rollouts`: one full pass over the frozen instance set to score the
// seed, plus one iteration's guaranteed cost. A run started at exactly this budget can still
// enter iteration 1 (`shouldContinueLoop`'s guard is `rolloutsUsed + iterationCost <=
// budgetRollouts`, so equality passes).
export function minimumViableBudget(mode: OptimizationMode, instanceCount: number): number {
  return instanceCount + iterationCost(mode, instanceCount);
}
