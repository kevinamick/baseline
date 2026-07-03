// Shared candidate-step machine driving ONE candidate's propose -> rollout(s) pipeline for BOTH
// Optimization Modes (#385, extending the #380 pause/probe state-machine pattern to the whole
// iteration loop). Pure decision logic — no Temporal imports, no Date.now/Math.random (ADR-0006's
// determinism boundary): the workflow stays the sole owner of every Activity call and the
// Math.random draws that feed Mode-specific sampling (pareto.ts's sampleParent, selection.ts's
// sampleElite); this module only sequences "propose the child, roll it out, decide whether it's
// kept" and folds the outcome fed back as an event into the next effect to run. Same shape as
// pause-machine.ts: `start*`/`advance*` return `{ state, effect }`, and the workflow's closure is
// just the wiring — execute the effect (an Activity call) and feed the result back as an event.
//
// Reflective (GEPA) and Simple Mode diverge only in POLICY, not in shape:
//   - GEPA rolls out the PARENT on a minibatch first (the accept/reject baseline the child must
//     beat), gates the child on strictly beating it, and follows an accepted child with a
//     full-set Pareto eval (only if the budget can still afford it — otherwise the caller must
//     stop the whole run without pooling an unscored child, mirroring the pre-#385 `break`).
//   - Simple has no parent rollout (the sampled elite is already scored on the full set from an
//     earlier step), no accept/reject gate (every proposed child is scored and kept — selection
//     happens at the round level via `topK`), and no follow-up eval (the one rollout already
//     covers the full set).
// An OptimizationStepPolicy captures exactly that divergence; the state machine itself, and the
// "drive it to completion" loop each workflow's closure runs, are shared.

export interface RolloutOutcome {
  overallScore: number;
  instanceScores: Record<number, number>;
  instancesRun: number;
}

// Single-source list of state kinds; OptimizationStepState (the tagged union below) derives its
// `kind` literal from this instead of duplicating the string set.
export const OPTIMIZATION_STEP_STATE_KINDS = [
  "rolling-out-parent",
  "proposing",
  "rolling-out-child",
  "rolling-out-follow-up",
  "done",
] as const;
export type OptimizationStepStateKind = (typeof OPTIMIZATION_STEP_STATE_KINDS)[number];

export interface OptimizationStepResult {
  accepted: boolean;
  child: RolloutOutcome;
  // The full-set follow-up eval's outcome. Present only when the policy calls for one AND the
  // child was accepted AND the budget allowed it — null for Simple (no follow-up), a rejected
  // GEPA child, or a GEPA child accepted but budget-blocked (see `budgetExhausted`).
  followUp: RolloutOutcome | null;
  // True only when the child was accepted, the policy wanted a follow-up eval, but the caller's
  // budget could not afford it. The caller must stop the whole run right here — not just skip
  // this candidate — without pooling the unscored child (mirroring the pre-#385 `break`).
  budgetExhausted: boolean;
}

export type OptimizationStepState =
  | { kind: "rolling-out-parent" }
  | { kind: "proposing"; parent: RolloutOutcome | null }
  | { kind: "rolling-out-child"; parent: RolloutOutcome | null }
  | { kind: "rolling-out-follow-up"; child: RolloutOutcome }
  | { kind: "done"; result: OptimizationStepResult };

// Single-source list of event kinds the workflow feeds back after executing an effect.
export const OPTIMIZATION_STEP_EVENT_KINDS = [
  "parent-scored",
  "child-proposed",
  "child-scored",
  "follow-up-scored",
] as const;
export type OptimizationStepEventKind = (typeof OPTIMIZATION_STEP_EVENT_KINDS)[number];

export type OptimizationStepEvent =
  | { kind: "parent-scored"; outcome: RolloutOutcome }
  | { kind: "child-proposed" }
  | { kind: "child-scored"; outcome: RolloutOutcome }
  | { kind: "follow-up-scored"; outcome: RolloutOutcome };

// Single-source list of effect kinds; OptimizationStepEffect derives its `kind` from this.
export const OPTIMIZATION_STEP_EFFECT_KINDS = [
  "call-rollout-parent",
  "call-propose",
  "call-rollout-child",
  "call-rollout-follow-up",
  "none",
] as const;
export type OptimizationStepEffectKind = (typeof OPTIMIZATION_STEP_EFFECT_KINDS)[number];

export type OptimizationStepEffect =
  | { kind: "call-rollout-parent" }
  | { kind: "call-propose" }
  | { kind: "call-rollout-child" }
  | { kind: "call-rollout-follow-up" }
  // Terminal, nothing left to do — `state` carries the result (see OptimizationStepState).
  | { kind: "none" };

export interface OptimizationStepTransition {
  state: OptimizationStepState;
  effect: OptimizationStepEffect;
}

// Mode-specific policy — the only thing that varies between Reflective and Simple. Injected as
// data/a pure strategy rather than branching inside the machine.
export interface OptimizationStepPolicy {
  // GEPA: true (roll the parent out on a minibatch first). Simple: false (the sampled elite is
  // already scored on the full set — nothing to roll out before proposing).
  rolloutParent: boolean;
  // GEPA: true (an accepted child gets a full-set Pareto eval). Simple: false.
  hasFollowUp: boolean;
  // The accept/reject gate. GEPA: strictly beat the parent's minibatch score (`accepts` in
  // pareto.ts). Simple: always true — there is no gate, every proposed child is kept (selection
  // happens at the round level). `parentScore` is null exactly when `rolloutParent` is false.
  accepts(parentScore: number | null, childScore: number): boolean;
}

export interface OptimizationStepConfig {
  // Whether the run's rollout budget can still afford the follow-up (full-set) eval on top of
  // what's already been spent. Ignored when policy.hasFollowUp is false. Computed by the caller
  // from its own running rolloutsUsed/budgetRollouts — outside this pure module's scope.
  budgetAllowsFollowUp: boolean;
}

// Begin a fresh candidate step. The first effect depends only on the policy.
export function startOptimizationStep(policy: OptimizationStepPolicy): OptimizationStepTransition {
  if (policy.rolloutParent) {
    return { state: { kind: "rolling-out-parent" }, effect: { kind: "call-rollout-parent" } };
  }
  return { state: { kind: "proposing", parent: null }, effect: { kind: "call-propose" } };
}

// Fold one event into the current state, returning the next state and the effect to execute.
// Throws on an event that can't occur in the given state — that would be a caller bug (feeding
// the wrong event back), not a domain outcome for this state machine to model.
export function advanceOptimizationStep(
  state: OptimizationStepState,
  event: OptimizationStepEvent,
  policy: OptimizationStepPolicy,
  config: OptimizationStepConfig
): OptimizationStepTransition {
  switch (state.kind) {
    case "rolling-out-parent": {
      if (event.kind !== "parent-scored") throw invalidEvent(state, event);
      return {
        state: { kind: "proposing", parent: event.outcome },
        effect: { kind: "call-propose" },
      };
    }

    case "proposing": {
      if (event.kind !== "child-proposed") throw invalidEvent(state, event);
      return {
        state: { kind: "rolling-out-child", parent: state.parent },
        effect: { kind: "call-rollout-child" },
      };
    }

    case "rolling-out-child": {
      if (event.kind !== "child-scored") throw invalidEvent(state, event);
      const parentScore = state.parent?.overallScore ?? null;
      const accepted = policy.accepts(parentScore, event.outcome.overallScore);
      if (accepted && policy.hasFollowUp) {
        if (!config.budgetAllowsFollowUp) {
          return {
            state: {
              kind: "done",
              result: { accepted, child: event.outcome, followUp: null, budgetExhausted: true },
            },
            effect: { kind: "none" },
          };
        }
        return {
          state: { kind: "rolling-out-follow-up", child: event.outcome },
          effect: { kind: "call-rollout-follow-up" },
        };
      }
      return {
        state: {
          kind: "done",
          result: { accepted, child: event.outcome, followUp: null, budgetExhausted: false },
        },
        effect: { kind: "none" },
      };
    }

    case "rolling-out-follow-up": {
      if (event.kind !== "follow-up-scored") throw invalidEvent(state, event);
      return {
        state: {
          kind: "done",
          result: {
            accepted: true,
            child: state.child,
            followUp: event.outcome,
            budgetExhausted: false,
          },
        },
        effect: { kind: "none" },
      };
    }

    case "done":
      throw invalidEvent(state, event);
  }
}

function invalidEvent(state: OptimizationStepState, event: OptimizationStepEvent): Error {
  return new Error(`optimization-step: event "${event.kind}" is invalid in state "${state.kind}"`);
}

// The effect kinds a driver ever needs to actually EXECUTE — "none" only ever appears as the
// terminal `state`'s co-located effect and is consumed by `driveOptimizationStep` itself, never
// handed to a caller-supplied executor.
export type OptimizationStepActiveEffect = Exclude<OptimizationStepEffect, { kind: "none" }>;

// Generic driver: runs the machine to completion, executing each commanded effect via the
// caller-supplied `execute` and feeding its result back in as the next event. This is orchestration
// wiring, not domain decision logic (it has no Temporal import and makes no Activity call itself —
// `execute` does, inside the workflow), so both Optimization Modes' workflow bodies reduce to
// supplying `execute` (a switch from effect kind to one Activity call) and a `budgetAllowsFollowUp`
// thunk (re-read fresh on every transition, since the caller's rolloutsUsed changes as effects run).
export async function driveOptimizationStep(
  policy: OptimizationStepPolicy,
  execute: (effect: OptimizationStepActiveEffect) => Promise<OptimizationStepEvent>,
  budgetAllowsFollowUp: () => boolean
): Promise<OptimizationStepResult> {
  let { state, effect } = startOptimizationStep(policy);
  while (effect.kind !== "none") {
    const event = await execute(effect);
    ({ state, effect } = advanceOptimizationStep(state, event, policy, {
      budgetAllowsFollowUp: budgetAllowsFollowUp(),
    }));
  }
  if (state.kind !== "done") {
    // Unreachable: the machine only ever produces effect: {kind: "none"} alongside state: {kind:
    // "done"} (see advanceOptimizationStep). Guards against a future state/effect drifting apart.
    throw new Error("optimization-step: machine exited without a terminal state");
  }
  return state.result;
}
