// Regression guard for the #102 pause-and-wait entry condition: pause must NEVER kick in on
// the first call to the optimization pipeline (the seed Pareto rollout), and must only fire
// after the seed has completed AND the circuit breaker trips on CIRCUIT_BREAKER_THRESHOLD
// consecutive endpoint-failure iterations. The invariant is currently enforced structurally
// (the seed rollout sits outside the breaker-protected loop, and the breaker needs three
// consecutive failures), but the workflow loop itself has no other coverage — this pins it
// against future refactors.
//
// We drive the REAL runOptimizationWorkflow with the REAL circuit-breaker / pause-control
// helpers, mocking only the Temporal SDK primitives (proxyActivities, condition, log, …) and
// the Activities — the true boundary. No TestWorkflowEnvironment, so the test is fast,
// deterministic, and needs no native test-server binary.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PARETO } from "./phase.js";
import {
  AGENT_ENDPOINT_ERROR_TYPE,
  CIRCUIT_BREAKER_THRESHOLD,
  MANAGED_AGENT_CONFIG_TYPE,
  PROVIDER_KEY_MISSING_TYPE,
} from "./circuit-breaker.js";

// Shared, mutable mock registry — hoisted so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  // Activity name -> implementation. The proxyActivities Proxy resolves every call through
  // this object at CALL time, so tests can swap implementations per case.
  acts: {} as Record<string, (...args: unknown[]) => unknown>,
  // condition(predicate, timeoutMs): false = the durable timer elapsed (→ health probe),
  // true = the "retry now" signal was latched. These tests never signal, so it stays false.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  conditionImpl: { fn: async (..._args: unknown[]) => false as boolean },
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) =>
            h.acts[name](...args),
      },
    ),
  log: { warn() {}, info() {}, error() {}, debug() {} },
  // The workflow throws ApplicationFailure.create(...) from its outer catch; a plain Error
  // carrying the same fields is enough to observe the rejection.
  ApplicationFailure: {
    create: (o: { message?: string }) => Object.assign(new Error(o?.message ?? "failure"), o),
  },
  condition: (...args: unknown[]) => h.conditionImpl.fn(...args),
  defineSignal: (name: string) => ({ name }),
  setHandler: () => {},
}));

// Imported after the mock is registered (vi.mock is hoisted above imports).
import { runOptimizationWorkflow } from "./workflow.js";

// Mirrors what the rollout Activity surfaces on an outage: an error whose (nested) `type` is
// the marker the circuit breaker keys on (isEndpointFailure). Built from the exported constant
// so it can't drift from the breaker's contract.
function endpointError(): Error {
  return Object.assign(new Error("endpoint down"), { type: AGENT_ENDPOINT_ERROR_TYPE });
}

// Mirrors how a terminal managed-agent config or missing-key failure surfaces from an Activity:
// an ActivityFailure wrapping a nonRetryable ApplicationFailure with the relevant type.
function terminalConfigError(type: string, message: string): Error {
  const cause = Object.assign(new Error(message), { type, nonRetryable: true });
  return Object.assign(new Error("Activity task failed"), { name: "ActivityFailure", cause });
}

// A successful full-set (Pareto) seed score.
function seedScore() {
  return { overallScore: 0.5, instanceScores: { 0: 0.5 }, instancesRun: 5 };
}

// seedRun config that lets the loop run: one Module, a non-empty frozen set, ample budget.
// maxIters is set per-test to bound how many iterations get to fail. plateau is disabled so a
// failed iteration can't end the run before the breaker is the one to react.
function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "seed",
    instanceCount: 5,
    modules: ["main"],
    budgetRollouts: 100,
    maxIters: CIRCUIT_BREAKER_THRESHOLD,
    plateauPatience: null,
    pauseMaxWaitMinutes: 60,
    probeIntervalSeconds: 60,
    ...overrides,
  };
}

describe("runOptimizationWorkflow — pause-and-wait entry guard (#102)", () => {
  let events: string[];
  let seedRun: Mock;
  let rolloutCandidate: Mock;
  let proposeCandidate: Mock;
  let probeEndpoint: Mock;
  let pauseRun: Mock;
  let resumeRun: Mock;
  let completeRun: Mock;
  let failRun: Mock;

  beforeEach(() => {
    events = [];
    h.conditionImpl.fn = async () => false; // timer always elapses; never signalled

    seedRun = vi.fn(async () => baseConfig());
    // Default: every rollout succeeds. Cases that exercise an outage override this.
    rolloutCandidate = vi.fn(async (input: { phase: string }) => {
      events.push(input.phase === PARETO ? "seed-scored" : "rollout-ok");
      return seedScore();
    });
    proposeCandidate = vi.fn(async () => ({ childCandidateId: "child" }));
    // Default: the endpoint is healthy whenever probed (so a pause, if any, resumes).
    probeEndpoint = vi.fn(async () => ({ healthy: true }));
    pauseRun = vi.fn(async () => void events.push("paused"));
    resumeRun = vi.fn(async () => void events.push("resumed"));
    completeRun = vi.fn(async () => void events.push("completed"));
    failRun = vi.fn(async () => void events.push("failed"));

    Object.assign(h.acts, {
      seedRun,
      rolloutCandidate,
      proposeCandidate,
      probeEndpoint,
      pauseRun,
      resumeRun,
      completeRun,
      failRun,
    });
  });

  it("fails — never pauses — when the endpoint is down on the very first (seed) pipeline call", async () => {
    // The seed Pareto rollout is the first endpoint call and sits OUTSIDE the breaker loop.
    rolloutCandidate = vi.fn(async () => {
      events.push("rollout-attempt");
      throw endpointError();
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await expect(runOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(/endpoint down/);

    // Only the seed rollout was attempted — the loop was never entered.
    expect(rolloutCandidate).toHaveBeenCalledTimes(1);
    // No work completed, so pause-and-wait must not have engaged; the run failed terminally.
    expect(pauseRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(completeRun).not.toHaveBeenCalled();
    expect(events).toEqual(["rollout-attempt", "failed"]);
  });

  it("pauses only after the seed completes and CIRCUIT_BREAKER_THRESHOLD consecutive endpoint failures", async () => {
    // Seed scores fine (the full-set Pareto eval); every in-loop minibatch rollout then fails
    // as an endpoint outage, one failed iteration per call.
    rolloutCandidate = vi.fn(async (input: { phase: string }) => {
      if (input.phase === PARETO) {
        events.push("seed-scored");
        return seedScore();
      }
      events.push("rollout-failed");
      throw endpointError();
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    // Pause fired exactly once...
    expect(pauseRun).toHaveBeenCalledTimes(1);
    // ...and only after the seed scored + exactly THRESHOLD failed iterations — never earlier.
    const expectedPrefix = [
      "seed-scored",
      ...Array(CIRCUIT_BREAKER_THRESHOLD).fill("rollout-failed"),
      "paused",
    ];
    expect(events.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    // The endpoint was healthy on the first probe, so the run resumed and completed — not failed.
    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(failRun).not.toHaveBeenCalled();
  });

  it("does not pause when fewer than CIRCUIT_BREAKER_THRESHOLD consecutive endpoint failures occur", async () => {
    // One short of the threshold: the loop runs out of iterations before the breaker can trip.
    seedRun = vi.fn(async () => baseConfig({ maxIters: CIRCUIT_BREAKER_THRESHOLD - 1 }));
    h.acts.seedRun = seedRun;
    rolloutCandidate = vi.fn(async (input: { phase: string }) => {
      if (input.phase === PARETO) {
        events.push("seed-scored");
        return seedScore();
      }
      events.push("rollout-failed");
      throw endpointError();
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await runOptimizationWorkflow({ optRunId: "run_1" });

    expect(pauseRun).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledTimes(1);
  });

  it("fails terminally on MANAGED_AGENT_CONFIG without completing further iterations", async () => {
    // A managed agent connection with an invalid target_model must fail the whole run immediately —
    // not continue burning rollout budget across iterations that will all fail identically.
    rolloutCandidate = vi.fn(async (input: { phase: string }) => {
      if (input.phase === PARETO) {
        events.push("seed-scored");
        return seedScore();
      }
      events.push("rollout-attempted");
      throw terminalConfigError(MANAGED_AGENT_CONFIG_TYPE, "invalid target_model");
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await expect(runOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(/invalid target_model/);

    // Only the seed and first iteration's parent rollout were attempted — the run failed terminally.
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(completeRun).not.toHaveBeenCalled();
    expect(pauseRun).not.toHaveBeenCalled();
    // Exactly one "rollout-attempted" event: the inner catch re-threw immediately on the first
    // failure rather than continuing to the next iteration.
    expect(events.filter((e) => e === "rollout-attempted")).toHaveLength(1);
  });

  it("fails terminally on PROVIDER_KEY_MISSING without continuing the loop", async () => {
    rolloutCandidate = vi.fn(async (input: { phase: string }) => {
      if (input.phase === PARETO) {
        events.push("seed-scored");
        return seedScore();
      }
      events.push("rollout-attempted");
      throw terminalConfigError(PROVIDER_KEY_MISSING_TYPE, "no provider key configured");
    });
    h.acts.rolloutCandidate = rolloutCandidate;

    await expect(runOptimizationWorkflow({ optRunId: "run_1" })).rejects.toThrow(/no provider key/);

    expect(failRun).toHaveBeenCalledTimes(1);
    expect(completeRun).not.toHaveBeenCalled();
    expect(events.filter((e) => e === "rollout-attempted")).toHaveLength(1);
  });
});
