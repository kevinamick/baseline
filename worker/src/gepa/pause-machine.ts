// GEPA endpoint-recovery pause/probe state machine (#380). Pure decision logic for one pause
// EPISODE: given the current state and an event fed back from the workflow (a probe result, the
// "retry now" signal, or a wait timer elapsing), returns the next state and the effect (command)
// the workflow must execute next. No Temporal imports, no Date.now/Math.random — the workflow
// stays the sole owner of timers, signals, and awaits (ADR-0006); this module only folds
// already-observed outcomes into state, so it's importable outside the Temporal sandbox and
// driven directly by plain vitest tests.
//
// This is a tracer bullet for #385 (a whole-loop step machine) — the pattern (single-source
// state/event/effect kinds, a pure `advance` fold, the workflow as a thin execute-effect/feed-
// event-back loop) is deliberately reusable, but this module's SCOPE stays the pause/probe
// closure only.
//
// Builds on pause-control.ts's per-probe backoff bookkeeping (startPauseWait/advancePauseWait):
// this module wraps that in the surrounding episode — enter (record paused), the wait-or-probe
// loop, and exit (resume or give up) — so the workflow's closure reduces to "run the effect,
// feed the outcome back."

import { advancePauseWait, startPauseWait, type PauseWaitState } from "./pause-control.js";

// Single-source list of state kinds; PauseMachineState (the tagged union below) derives its
// `kind` literal from this instead of duplicating the string set.
export const PAUSE_MACHINE_STATE_KINDS = [
  "entering",
  "waiting",
  "probing",
  "resuming",
  "resumed",
  "given-up",
] as const;
export type PauseMachineStateKind = (typeof PAUSE_MACHINE_STATE_KINDS)[number];

export type PauseMachineState =
  // Waiting on the pauseRun Activity to record the pause before the probe loop can start.
  | { kind: "entering" }
  // Racing the backoff timer against the "retry now" signal.
  | { kind: "waiting"; wait: PauseWaitState }
  // The backoff timer fired; the probeEndpoint Activity is in flight.
  | { kind: "probing"; wait: PauseWaitState }
  // Endpoint recovered or the user overrode: waiting on the resumeRun Activity.
  | { kind: "resuming"; wait: PauseWaitState }
  // Terminal: resumed successfully. `wait` carries the final cumulative paused time.
  | { kind: "resumed"; wait: PauseWaitState }
  // Terminal: the max-wait cap elapsed without recovery.
  | { kind: "given-up"; wait: PauseWaitState };

// Single-source list of event kinds the workflow feeds back after executing an effect.
export const PAUSE_MACHINE_EVENT_KINDS = [
  "pause-recorded",
  "wait-elapsed",
  "wait-signalled",
  "probe-result",
  "resume-recorded",
] as const;
export type PauseMachineEventKind = (typeof PAUSE_MACHINE_EVENT_KINDS)[number];

export type PauseMachineEvent =
  // pauseRun Activity completed.
  | { kind: "pause-recorded" }
  // The backoff timer elapsed before the "retry now" signal did.
  | { kind: "wait-elapsed" }
  // The "retry now" signal arrived (either before the timer, or discovered after a probe
  // completed — the caller re-checks the latch and prefers this event over "probe-result" in
  // either state, since the manual override always wins).
  | { kind: "wait-signalled" }
  // probeEndpoint Activity settled (a thrown/timed-out Activity call is the caller's job to map
  // to `healthy: false` — this module only sees the verdict).
  | { kind: "probe-result"; healthy: boolean }
  // resumeRun Activity completed.
  | { kind: "resume-recorded" };

// Single-source list of effect kinds; PauseMachineEffect derives its `kind` from this.
export const PAUSE_MACHINE_EFFECT_KINDS = [
  "call-pause-run",
  "wait",
  "call-probe",
  "call-resume-run",
  "give-up",
  "none",
] as const;
export type PauseMachineEffectKind = (typeof PAUSE_MACHINE_EFFECT_KINDS)[number];

export type PauseMachineEffect =
  | { kind: "call-pause-run" }
  | { kind: "wait"; delayMs: number }
  | { kind: "call-probe" }
  | { kind: "call-resume-run" }
  // Give up: the caller should throw (message composition is the caller's concern — it already
  // has the user-facing minute count in scope; this module only signals the terminal condition).
  | { kind: "give-up" }
  // Terminal, nothing left to do.
  | { kind: "none" };

export interface PauseMachineConfig {
  // Delay before the FIRST probe of a fresh episode; backs off from there per failed probe.
  probeIntervalMs: number;
  // Cap on TOTAL paused time across every episode of the run (issue #102) — not reset per
  // episode.
  maxWaitMs: number;
  // Cumulative paused time carried in from earlier episodes of the same run.
  initialElapsedMs: number;
}

export interface PauseMachineTransition {
  state: PauseMachineState;
  effect: PauseMachineEffect;
}

// Begin a fresh pause episode. The first effect is always recording the pause.
export function startPauseMachine(): PauseMachineTransition {
  return { state: { kind: "entering" }, effect: { kind: "call-pause-run" } };
}

// Fold one event into the current state, returning the next state and the effect to execute.
// Throws on an event that can't occur in the given state — that would be a caller bug (feeding
// the wrong event back), not a domain outcome for this state machine to model.
export function advancePauseMachine(
  state: PauseMachineState,
  event: PauseMachineEvent,
  config: PauseMachineConfig
): PauseMachineTransition {
  switch (state.kind) {
    case "entering": {
      if (event.kind !== "pause-recorded") {
        throw invalidEvent(state, event);
      }
      const wait = startPauseWait(config.probeIntervalMs, config.initialElapsedMs);
      return { state: { kind: "waiting", wait }, effect: { kind: "wait", delayMs: wait.delayMs } };
    }

    case "waiting": {
      if (event.kind === "wait-signalled") {
        return { state: { kind: "resuming", wait: state.wait }, effect: { kind: "call-resume-run" } };
      }
      if (event.kind === "wait-elapsed") {
        return { state: { kind: "probing", wait: state.wait }, effect: { kind: "call-probe" } };
      }
      throw invalidEvent(state, event);
    }

    case "probing": {
      // The manual override always wins, even one discovered only after the probe settled.
      if (event.kind === "wait-signalled") {
        return { state: { kind: "resuming", wait: state.wait }, effect: { kind: "call-resume-run" } };
      }
      if (event.kind !== "probe-result") {
        throw invalidEvent(state, event);
      }
      const decision = advancePauseWait(
        state.wait,
        event.healthy ? "probe-ok" : "probe-failed",
        config.maxWaitMs
      );
      if (decision.kind === "resume") {
        return { state: { kind: "resuming", wait: state.wait }, effect: { kind: "call-resume-run" } };
      }
      if (decision.kind === "give-up") {
        return { state: { kind: "given-up", wait: state.wait }, effect: { kind: "give-up" } };
      }
      return {
        state: { kind: "waiting", wait: decision.state },
        effect: { kind: "wait", delayMs: decision.state.delayMs },
      };
    }

    case "resuming": {
      if (event.kind !== "resume-recorded") {
        throw invalidEvent(state, event);
      }
      return { state: { kind: "resumed", wait: state.wait }, effect: { kind: "none" } };
    }

    case "resumed":
    case "given-up":
      throw invalidEvent(state, event);
  }
}

function invalidEvent(state: PauseMachineState, event: PauseMachineEvent): Error {
  return new Error(`pause-machine: event "${event.kind}" is invalid in state "${state.kind}"`);
}
