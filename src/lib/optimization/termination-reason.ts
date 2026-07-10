/**
 * App-facing re-export of the shared Optimization Run termination-reason codes (#469). The
 * single definition lives in worker/src/gepa/termination-reason.ts (zero relative imports, same
 * convention as worker/src/providers/registry.ts — see that file's shim,
 * src/lib/llm/providers.ts, for the precedent) so the run detail panel's code -> copy mapping
 * can never drift from the set the workflow actually writes.
 *
 * This file stays the app's import path (`@/lib/optimization/termination-reason`) rather than
 * every app call site reaching across the package boundary itself.
 */
export {
  TERMINATION_REASONS,
  type TerminationReason,
  isTerminationReason,
} from "../../../worker/src/gepa/termination-reason";
