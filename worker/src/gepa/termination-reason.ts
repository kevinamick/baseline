// Termination reason codes for Optimization Runs that complete without ever entering
// iteration 1 (#469). Prod incident: run opt-4afa3642 completed looking identical to a
// successful optimization — status completed, best candidate set to the seed, no error — the
// only symptom was its full rollout budget spent on the baseline (seed) evaluation alone with a
// lift of zero. Both Modes charge the seed evaluation unconditionally before the loop's entry
// guards run (`canLoop` — no Modules or no Instances — and the budget/iteration guard,
// `shouldContinueLoop` in circuit-breaker.ts), so a degenerate completion is otherwise
// indistinguishable from a genuine one.
//
// A REASON CODE, not prose (the project's single-source-enums convention, applied here at
// package scale like providers/registry.ts): the UI owns translating a code to user-facing copy
// in each locale, so the stored value never needs a migration to reword it. This file has
// deliberately ZERO relative imports, so it sidesteps the dataset-adapter subtree's
// extensionless-import sharp edge the same way registry.ts does (see worker/CLAUDE.md) — the
// app re-exports it via a thin shim (src/lib/optimization/termination-reason.ts) rather than
// reaching across the package boundary at every call site.

export const TERMINATION_REASONS = [
  // canLoop was true (Modules + Instances both present), but the loop's own budget/iteration
  // guard (shouldContinueLoop) refused to admit iteration 1: after the seed's rollout cost, the
  // remaining budget_rollouts couldn't cover one full iteration (for GEPA that's both minibatches
  // PLUS the accepted child's full-set validation — reflectiveIterationCost in
  // circuit-breaker.ts; for Simple Mode, one full-set scoring pass).
  "budget_exhausted_by_baseline",
  // canLoop was false: the Connection has no optimizable Modules, so there is nothing to mutate.
  "no_modules",
  // canLoop was false: the frozen Instance set is empty, so there is nothing to score against.
  "no_instances",
] as const;

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export function isTerminationReason(value: unknown): value is TerminationReason {
  return typeof value === "string" && (TERMINATION_REASONS as readonly string[]).includes(value);
}

export interface TerminationReasonInput {
  // modules.length from seedRun's result.
  modulesCount: number;
  // instanceCount from seedRun's result.
  instanceCount: number;
  // The loop's own 0-based completed-iteration count after it exits — GEPA's `iters`, Simple's
  // `round`. Zero means the `while` loop's guard never admitted a single pass.
  loopIterations: number;
}

// Pure decision, called once by each workflow right before completeRun: derives WHY a run
// completed without ever entering the loop, or null when it genuinely ran (or ran normally to a
// budget/iteration/plateau stop after at least one iteration — that's a normal completion, not a
// degenerate one). Order matters: a Connection with no Modules can't loop regardless of Instance
// count, so `no_modules` is checked first.
export function deriveTerminationReason(
  input: TerminationReasonInput,
): TerminationReason | null {
  if (input.modulesCount === 0) return "no_modules";
  if (input.instanceCount === 0) return "no_instances";
  if (input.loopIterations === 0) return "budget_exhausted_by_baseline";
  return null;
}
