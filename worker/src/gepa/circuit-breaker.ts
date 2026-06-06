// Circuit breaker for the GEPA loop (#90). A broken or hostile customer endpoint must not be
// allowed to burn the whole rollout budget: after K consecutive iterations whose failure is the
// AGENT endpoint (not, say, the reflection model), abort the run rather than retrying to budget
// exhaustion. These are pure helpers so both the workflow and unit tests can drive them — the
// module is sandbox-safe (no node built-ins), so the Temporal workflow can import it directly.

// Consecutive endpoint-failed iterations that trip the breaker. Conservative (D12): a couple of
// transient blips are absorbed by the per-Activity retry policy; a sustained outage trips here.
export const CIRCUIT_BREAKER_THRESHOLD = 3;

// Mirrors the AgentEndpointError class name thrown in worker/src/agent.ts. The rollout Activity
// rethrows endpoint failures as an ApplicationFailure with this `type`, so when the workflow
// catches an ActivityFailure its `.cause` carries this marker. Kept in sync by agent.test.ts.
export const AGENT_ENDPOINT_ERROR_TYPE = "AgentEndpointError";

interface FailureLike {
  type?: string | null;
  cause?: unknown;
}

// True if any link in the error's `cause` chain is our endpoint-failure marker. Temporal wraps an
// Activity failure as ActivityFailure → ApplicationFailure(type), so the marker is nested one or
// more `cause` levels down. Guards against cycles in case a converter ever self-references.
export function isEndpointFailure(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if ((cur as FailureLike).type === AGENT_ENDPOINT_ERROR_TYPE) return true;
    cur = (cur as FailureLike).cause;
  }
  return false;
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
