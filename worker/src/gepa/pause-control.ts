// Pause-and-wait decision helpers for the GEPA loop (#102). When the circuit breaker trips
// (see circuit-breaker.ts), the workflow no longer fails the run — it pauses in place and
// waits for the customer endpoint to recover, probing on a backoff schedule with a
// "retry now" signal as a manual override and a max-wait cap as the backstop for a
// permanently-dead endpoint. The wait-step bookkeeping (backoff progression + cap
// accounting) lives here as pure, sandbox-safe helpers (no node built-ins) so the Temporal
// workflow can import them directly and unit tests can drive them — mirroring
// advanceBreaker/advancePlateau.

// Backoff between failed health probes: each failed probe doubles the delay, capped so a
// long outage is still noticed within minutes of recovery rather than hours.
export const PROBE_BACKOFF_COEFFICIENT = 2;
export const MAX_PROBE_DELAY_MS = 15 * 60 * 1000;

// What ended one wait step: the backoff timer fired and the health probe succeeded/failed,
// or the user's "retry now" signal arrived before the timer did.
export type PauseWaitEvent = "probe-ok" | "probe-failed" | "retry-now";

export interface PauseWaitState {
  // Total time spent paused so far, accounted deterministically as the sum of completed
  // wait-step delays (replay-safe: no wall-clock reads in the workflow).
  elapsedMs: number;
  // Delay before the next health probe.
  delayMs: number;
}

export type PauseWaitDecision =
  // Endpoint recovered (probe succeeded) or the user asked to retry now: resume the loop.
  | { kind: "resume" }
  // The max-wait cap elapsed without recovery: fail the run (the pre-#102 behavior).
  | { kind: "give-up" }
  // Probe failed with budget left: keep waiting, with the backed-off next state.
  | { kind: "wait"; state: PauseWaitState };

// The state for a freshly-entered pause: nothing elapsed, first probe after the configured
// initial interval.
export function startPauseWait(probeIntervalMs: number): PauseWaitState {
  return { elapsedMs: 0, delayMs: probeIntervalMs };
}

// The delay before the probe after this one: exponential backoff, capped.
export function nextProbeDelayMs(delayMs: number): number {
  return Math.min(delayMs * PROBE_BACKOFF_COEFFICIENT, MAX_PROBE_DELAY_MS);
}

// Fold one wait step's outcome into the pause state. A successful probe or the retry-now
// signal resumes immediately — the signal doesn't even wait for a probe, because the user
// asserting "it's fixed" is the override; if they're wrong, the breaker just trips and
// pauses again. Only a FAILED probe advances the elapsed clock (by the full delay that was
// just waited out) and the cap check runs on that accounting.
export function advancePauseWait(
  state: PauseWaitState,
  event: PauseWaitEvent,
  maxWaitMs: number
): PauseWaitDecision {
  if (event === "retry-now" || event === "probe-ok") return { kind: "resume" };
  const elapsedMs = state.elapsedMs + state.delayMs;
  if (elapsedMs >= maxWaitMs) return { kind: "give-up" };
  return { kind: "wait", state: { elapsedMs, delayMs: nextProbeDelayMs(state.delayMs) } };
}
