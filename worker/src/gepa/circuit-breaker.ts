// Termination guardrails for the Optimization loop, shared by Reflective (GEPA) and Simple Mode
// (#90, #385): the circuit breaker (a broken endpoint must not burn the whole rollout budget),
// the plateau backstop (stop once progress stops improving), the outer loop's continuation guard,
// and the per-iteration failure classification that decides whether a caught error is a benign
// hiccup to absorb or a terminal run failure to re-throw. All fold one iteration/round's outcome
// into loop-control state, so they live together as pure helpers the workflow and unit tests can
// drive. The module is sandbox-safe (no node built-ins), so the Temporal workflow can import it
// directly.
//
// Why breaker + plateau live here: a failed iteration looks like "no progress" to a naive plateau
// counter, so counting failures toward the plateau lets a small plateau_patience terminate the run
// on the seed BEFORE the breaker can fire — silently masking a dead endpoint as a benign
// completion. advancePlateau and advanceBreaker split that responsibility explicitly.
//
// Why classifyIterationFailure lives here: this is the KNOWN TRAP (#385) — the loop's inner
// per-iteration catch must re-throw a terminal run failure (isTerminalRunFailure) past itself
// rather than absorbing it as just another failed iteration, or a permanent failure (a missing
// provider key, an invalid managed-agent config, a managed-spend cap breach) would silently read
// as a benign "completed on the seed" instead of the run it actually is. Naming the decision as
// one pure, directly-testable function (rather than leaving the if/else inline in each workflow's
// catch block) is what makes that path testable outside the Temporal harness.

// Consecutive endpoint-failed iterations that trip the breaker. Conservative (D12): a couple of
// transient blips are absorbed by the per-Activity retry policy; a sustained outage trips here.
export const CIRCUIT_BREAKER_THRESHOLD = 3;

// Instances scored in each Reflective (GEPA) accept/reject minibatch test (D9 sizing); Simple
// Mode has no minibatch — it scores every candidate on the full instance set (see
// simple/workflow.ts). Single-sourced HERE rather than in gepa/workflow.ts (which imports
// `@temporalio/workflow` and must never enter the Next app bundle) so the app's minimum-viable-
// budget check (`src/lib/optimization/budget.ts`, #468) can import the exact number GEPA uses —
// this module is import-free (see the module doc comment), so it's safely app-reachable the same
// way `worker/src/prompt-refs.ts` is.
export const MINIBATCH_SIZE = 5;

// Mirrors the AgentEndpointError class name thrown in worker/src/agent.ts. The rollout Activity
// rethrows endpoint failures as an ApplicationFailure with this `type`, so when the workflow
// catches an ActivityFailure its `.cause` carries this marker. Kept in sync by agent.test.ts.
export const AGENT_ENDPOINT_ERROR_TYPE = "AgentEndpointError";

// Mirrors the ApplicationFailure type rethrowManagedAsTerminal (activities.ts) stamps onto a
// terminal managed-spend failure: the Managed Spend Cap was reached mid-run, a managed payment is
// blocked, or a managed model can't be priced. Unlike an endpoint blip, this is NOT a per-iteration
// hiccup the loop should absorb — it must fail the whole run, so the workflow re-throws it past the
// inner catch instead of counting it toward the breaker/plateau (#291).
export const MANAGED_SPEND_BLOCKED_TYPE = "MANAGED_SPEND_BLOCKED";

// Mirrors the ApplicationFailure type thrown when a managed agent connection has an invalid or
// missing target_model. A config error cannot recover through iteration retries — fail the run.
export const MANAGED_AGENT_CONFIG_TYPE = "MANAGED_AGENT_CONFIG";

// Mirrors the ApplicationFailure type thrown when the team has no provider key available.
// No iteration retry can produce a key — the whole run must fail terminally.
export const PROVIDER_KEY_MISSING_TYPE = "PROVIDER_KEY_MISSING";

interface FailureLike {
  type?: string | null;
  cause?: unknown;
}

// Walk the error's `cause` chain looking for an ApplicationFailure whose `type` matches `marker`.
// Temporal wraps an Activity failure as ActivityFailure → ApplicationFailure(type), so the marker
// is nested one or more `cause` levels down. Guards against cycles in case a converter ever
// self-references.
function hasFailureType(err: unknown, marker: string): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if ((cur as FailureLike).type === marker) return true;
    cur = (cur as FailureLike).cause;
  }
  return false;
}

// True if the failure is (nested) our endpoint-failure marker — the circuit breaker's domain.
export function isEndpointFailure(err: unknown): boolean {
  return hasFailureType(err, AGENT_ENDPOINT_ERROR_TYPE);
}

// True if the failure is (nested) a terminal managed-spend block — the whole run must fail.
export function isManagedSpendBlocked(err: unknown): boolean {
  return hasFailureType(err, MANAGED_SPEND_BLOCKED_TYPE);
}

// True if the failure is any terminal run-level error that the per-iteration catch must re-throw
// to the outer catch (which calls failRun). These are permanent failures — no iteration retry
// will recover them, so continuing the loop would only burn rollout budget on the seed.
export function isTerminalRunFailure(err: unknown): boolean {
  return (
    isManagedSpendBlocked(err) ||
    hasFailureType(err, MANAGED_AGENT_CONFIG_TYPE) ||
    hasFailureType(err, PROVIDER_KEY_MISSING_TYPE)
  );
}

export type IterationOutcome = "ok" | "endpoint-failure" | "other-failure";

export interface BreakerState {
  // Running count of consecutive endpoint-failed iterations.
  consecutive: number;
  // True once `consecutive` reaches the threshold — the run should abort.
  tripped: boolean;
}

// Fold one iteration's outcome into the breaker's consecutive-failure count. Only consecutive
// ENDPOINT failures advance it; a success or a non-endpoint failure breaks the streak and resets
// to 0 (the endpoint isn't what's broken). Trips when the count reaches the threshold.
export function advanceBreaker(
  prevConsecutive: number,
  outcome: IterationOutcome,
  threshold: number = CIRCUIT_BREAKER_THRESHOLD
): BreakerState {
  if (outcome !== "endpoint-failure") return { consecutive: 0, tripped: false };
  const consecutive = prevConsecutive + 1;
  return { consecutive, tripped: consecutive >= threshold };
}

// Fold one iteration's outcome into the plateau counter (no-frontier-gain streak). ONLY a
// successful iteration moves it: a gain resets it to 0, a success without a gain advances it. A
// failed iteration (endpoint or other) didn't actually explore, so it leaves the counter
// unchanged — failure is the circuit breaker's domain, not the plateau's. This is what stops a
// dead endpoint from tripping the plateau (and masking itself as a benign completion) before the
// breaker fires.
export function advancePlateau(
  prev: number,
  outcome: IterationOutcome,
  frontierGain: boolean
): number {
  if (outcome !== "ok") return prev;
  return frontierGain ? 0 : prev + 1;
}

// The outer loop's continuation guard, shared by both Modes' `while` condition: only enter
// another iteration/round while its guaranteed rollout cost still fits the budget ceiling, the
// iteration/round cap hasn't been reached, and the plateau hasn't exhausted its patience.
// `iterationCost` is Mode-specific (GEPA: the parent+child minibatch pair, `2 * minibatch`;
// Simple: one full-set scoring, `instanceCount`) — the guard itself is identical arithmetic, so
// it's expressed once instead of as two near-identical inline `while` conditions.
export interface LoopBudgetState {
  rolloutsUsed: number;
  // Guaranteed rollout cost of entering one more iteration/round (Mode-specific; see above).
  iterationCost: number;
  budgetRollouts: number;
  // GEPA: `iters`. Simple: `round`. Both are a 0-based count of completed iterations/rounds.
  iters: number;
  maxIters: number;
  plateau: number;
  plateauPatience: number | null;
}

export function shouldContinueLoop(state: LoopBudgetState): boolean {
  return (
    state.rolloutsUsed + state.iterationCost <= state.budgetRollouts &&
    state.iters < state.maxIters &&
    (state.plateauPatience == null || state.plateau < state.plateauPatience)
  );
}

// The per-iteration failure classification both workflows' inner catch calls. This is the ONE
// place the "terminal failure vs benign per-iteration hiccup" decision is made — see the module
// doc comment for why that decision must live in a pure, directly-testable function rather than
// inline in each workflow's catch block.
export type IterationFailureClassification =
  | { rethrow: true }
  | { rethrow: false; outcome: IterationOutcome };

export function classifyIterationFailure(err: unknown): IterationFailureClassification {
  if (isTerminalRunFailure(err)) return { rethrow: true };
  return { rethrow: false, outcome: isEndpointFailure(err) ? "endpoint-failure" : "other-failure" };
}
