// The GEPA Optimization Workflow (arXiv:2507.19457). Runs inside Temporal's deterministic
// sandbox, so it carries only IDs and orchestrates Activities — no DB, no Date.now (ADR-0006).
// Math.random() IS deterministic here (the SDK seeds and replays it), so the Pareto sampler's
// random draw is sourced in-workflow and passed to a pure helper.
//
// The loop: seed Candidate 0 and score it on the full set, then iterate — Pareto-sample a
// parent from the frontier, round-robin a target Module, mutate it, and keep the child only if
// it beats the parent on a minibatch; an accepted child is scored on the full set and joins the
// pool. Terminate on whichever trips first: rollout budget, max iterations, or a plateau.

import {
  proxyActivities,
  log,
  ApplicationFailure,
  condition,
  defineSignal,
  setHandler,
} from "@temporalio/workflow";
// Type-only: erased at bundle time, so the DB-touching Activity code never enters the sandbox.
import type * as activities from "./activities.js";
import {
  accepts,
  improvesFrontier,
  instanceMaxima,
  sampleParent,
  type ScoredCandidate,
} from "./pareto.js";
import { MINIBATCH, PARETO } from "./phase.js";
import {
  advanceBreaker,
  advancePlateau,
  classifyIterationFailure,
  shouldContinueLoop,
  type IterationOutcome,
} from "./circuit-breaker.js";
import {
  advancePauseMachine,
  startPauseMachine,
  type PauseMachineEvent,
} from "./pause-machine.js";
import { driveOptimizationStep, type OptimizationStepPolicy } from "./optimization-step.js";
import { OPTIMIZATION_RETRY_NOW_SIGNAL } from "../temporal/connection.js";
import { rootCauseMessage } from "../temporal/failure.js";

// The rollout Activity invokes the customer endpoint, so it gets its own capped retry policy
// (#90): a few transient blips are absorbed here with backoff, but maximumAttempts caps the
// retries so a down endpoint can't loop forever — the workflow's circuit breaker takes over
// once retries are exhausted across consecutive iterations.
const { rolloutCandidate } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

// Bookkeeping Activities (seed / propose / complete / fail / pause / resume): pure Postgres
// or a single reflection call, so a tighter timeout and the default capped retry are plenty.
const { seedRun, proposeCandidate, completeRun, failRun, pauseRun, resumeRun } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "5 minutes",
    retry: { maximumAttempts: 3 },
  });

// The health probe (#102) is a single cheap endpoint call that returns a verdict rather than
// throwing — an unhealthy endpoint is the expected answer during an outage, so it gets one
// attempt per backoff step (the pause loop IS the retry schedule).
const { probeEndpoint } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

// "Retry now" (#102): resumes a paused run immediately, signalled by name from the Next
// app's retryOptimizationRun action (the name is the client↔worker contract).
export const retryNowSignal = defineSignal(OPTIMIZATION_RETRY_NOW_SIGNAL);

export interface OptimizationWorkflowInput {
  optRunId: string;
}

// Instances scored in each accept/reject minibatch test (D9 sizing). The full frozen set is
// always used for a Candidate's Pareto score vector.
const MINIBATCH_SIZE = 5;

export async function runOptimizationWorkflow(input: OptimizationWorkflowInput): Promise<void> {
  const { optRunId } = input;

  // "Retry now" latch (#102). Registered before any await so a signal can never be dropped;
  // the pause loop clears and then awaits it via `condition`.
  let retryNowRequested = false;
  setHandler(retryNowSignal, () => {
    retryNowRequested = true;
  });

  try {
    const {
      candidateId: seedId,
      instanceCount,
      modules,
      budgetRollouts,
      maxIters,
      plateauPatience,
      pauseMaxWaitMinutes: seededPauseMaxWaitMinutes,
      probeIntervalSeconds: seededProbeIntervalSeconds,
    } = await seedRun(optRunId);

    // Workflows in flight at deploy time replay a seedRun result recorded before #102, which
    // has neither pause field — without defaults, the timers below compute NaN (a pause that
    // never probes and a cap that never trips). Defaulting here matches the DB column defaults
    // and is replay-deterministic: pre-#102 histories recorded no pause timers to diverge from.
    const pauseMaxWaitMinutes = (seededPauseMaxWaitMinutes as number | undefined) ?? 1440;
    const probeIntervalSeconds = (seededProbeIntervalSeconds as number | undefined) ?? 60;

    // Score the seed on the full frozen (Pareto) set: the pool's first member and the baseline
    // best. Its agent calls count against the budget, faithful to GEPA's rollout accounting.
    const seedPareto = await rolloutCandidate({ optRunId, candidateId: seedId, phase: PARETO });
    const pool: ScoredCandidate[] = [
      { candidateId: seedId, instanceScores: seedPareto.instanceScores },
    ];
    let bestCandidateId = seedId;
    let bestScore = seedPareto.overallScore;
    let rolloutsUsed = seedPareto.instancesRun;

    // Nothing to tune (no Modules) or nothing to score against (no instances): complete on seed.
    const canLoop = modules.length > 0 && instanceCount > 0;
    const minibatch = Math.min(MINIBATCH_SIZE, instanceCount);

    // Pause-and-wait (#102): when the circuit breaker trips, flip the run to 'paused' and
    // wait durably for the endpoint to recover instead of failing — probing on a backoff
    // schedule, interruptible by the "retry now" signal. All loop state (pool, rolloutsUsed,
    // iters, plateau) survives in this same workflow execution, so resuming continues from
    // exactly where the run paused. Throws (to the outer catch → failRun + non-retryable
    // ApplicationFailure) once the max-wait cap elapses without recovery.
    const maxWaitMs = pauseMaxWaitMinutes * 60 * 1000;
    // Total time spent paused across ALL pause episodes (sum of waited-out probe delays). The
    // cap is on this cumulative total — issue #102's "total paused time" — so an endpoint that
    // answers the cheap probe but keeps failing real rollouts can't reset its budget on every
    // pause → resume → pause cycle and hold the org's active slot indefinitely.
    let totalPausedMs = 0;
    // The pause/probe decision logic lives in pause-machine.ts as a pure state machine (#380);
    // this closure is just the wiring the sandbox requires — execute the effect it returns
    // (Activity call, durable timer) and feed the outcome back as an event.
    async function pauseUntilEndpointRecovers(): Promise<void> {
      // Only "retry now" signals sent while the run is visibly paused should resume it. Clear
      // the latch BEFORE the pauseRun await: from the moment that activity commits its update
      // (and the paused email goes out) the run is visibly paused, and a signal delivered in
      // the same activation that completes the activity would be wiped by a clear placed after
      // the await.
      retryNowRequested = false;
      const config = {
        probeIntervalMs: probeIntervalSeconds * 1000,
        maxWaitMs,
        initialElapsedMs: totalPausedMs,
      };
      let { state, effect } = startPauseMachine();

      for (;;) {
        switch (effect.kind) {
          case "call-pause-run": {
            await pauseRun({
              optRunId,
              reason:
                "Your agent endpoint stopped responding — the run is paused and waiting for it to recover",
            });
            log.warn("Optimization run paused: sustained endpoint outage", { optRunId });
            ({ state, effect } = advancePauseMachine(state, { kind: "pause-recorded" }, config));
            break;
          }

          case "wait": {
            // A durable timer raced against the signal: true = the latch was set (retry now),
            // false = the backoff delay elapsed and it's time to health-probe the endpoint.
            const signalled = await condition(() => retryNowRequested, effect.delayMs);
            const event: PauseMachineEvent = signalled
              ? { kind: "wait-signalled" }
              : { kind: "wait-elapsed" };
            ({ state, effect } = advancePauseMachine(state, event, config));
            break;
          }

          case "call-probe": {
            // The probe runs with maximumAttempts: 1 and this loop IS its retry schedule, so an
            // activity-level failure (endpoint hang past the activity timeout, worker restart
            // mid-probe, transient DB error resolving the connection) must count as "endpoint
            // still down" — never escape to the outer catch and fail the run terminally.
            let healthy = false;
            let message: string | undefined;
            try {
              const probe = await probeEndpoint({ optRunId });
              healthy = probe.healthy;
              message = probe.message;
            } catch (err) {
              message = rootCauseMessage(err);
            }
            // Re-check the latch: a "retry now" sent while the probe was in flight (a window of
            // up to its 2-minute timeout) must win over the probe's verdict — the user's explicit
            // override can't lose to a failed probe that tips the accounting over the cap.
            const event: PauseMachineEvent = retryNowRequested
              ? { kind: "wait-signalled" }
              : { kind: "probe-result", healthy };
            if (event.kind === "probe-result" && !event.healthy) {
              log.info("Endpoint probe failed; run stays paused", { optRunId, error: message });
            }
            ({ state, effect } = advancePauseMachine(state, event, config));
            break;
          }

          case "call-resume-run": {
            await resumeRun({ optRunId });
            log.info("Optimization run resumed: endpoint recovered", { optRunId });
            ({ state, effect } = advancePauseMachine(state, { kind: "resume-recorded" }, config));
            break;
          }

          case "give-up":
            throw new Error(
              `Your agent endpoint did not recover within the ${pauseMaxWaitMinutes}-minute pause budget — giving up on the run`
            );

          case "none":
            // Terminal: `state` is "resumed" here (the only state "none" is reachable from) —
            // carry its final cumulative paused time forward for the next pause episode, if any.
            if (state.kind === "resumed") totalPausedMs = state.wait.elapsedMs;
            return;
        }
      }
    }

    let iters = 0;
    let plateau = 0;
    // Circuit breaker (#90): consecutive iterations whose failure is the customer endpoint. A
    // sustained outage trips it and pauses the run (#102), rather than retrying to budget
    // exhaustion.
    let endpointFailures = 0;

    // The per-candidate propose -> rollout(s) pipeline is a pure step machine shared with Simple
    // Mode (#385, optimization-step.ts): roll the parent out on a minibatch first, gate the child
    // on strictly beating it (`accepts`, pareto.ts), and follow an accepted child with a full-set
    // Pareto eval. `parentScore` is never null here (rolloutParent is true), so the cast below is
    // safe — TypeScript can't see that invariant across the state machine's generic shape.
    const stepPolicy: OptimizationStepPolicy = {
      rolloutParent: true,
      hasFollowUp: true,
      accepts: (parentScore, childScore) => accepts(childScore, parentScore as number),
    };

    // budget_rollouts is a hard ceiling on agent invocations (D8), so only enter an iteration
    // when its guaranteed cost — the parent + child minibatch pair — still fits. The optional
    // full-set Pareto eval on an accepted child is gated separately below before it's spent.
    while (
      canLoop &&
      shouldContinueLoop({
        rolloutsUsed,
        iterationCost: 2 * minibatch,
        budgetRollouts,
        iters,
        maxIters,
        plateau,
        plateauPatience,
      })
    ) {
      const iteration = iters + 1; // 1-based, unique per run -> child identity (idempotent retries)
      const targetModule = modules[iters % modules.length]; // round-robin the Module to mutate
      let frontierGain = false;
      let outcome: IterationOutcome = "ok";
      let stopLoop = false;

      try {
        // Pareto-sample the parent from the frontier (win-weighted; Math.random is replay-safe).
        const parentId = sampleParent(pool, Math.random());
        let childCandidateId = "";

        // Drive the shared step machine to completion (optimization-step.ts): `execute` is the
        // only Mode-specific wiring left — a switch from the machine's commanded effect to the
        // one Activity call it maps to. Every Activity call, argument, and order here is
        // identical to the pre-#385 inline sequence; only the decision of "what's next" (the
        // accept/reject gate, whether the follow-up eval is affordable) moved into the machine.
        const result = await driveOptimizationStep(
          stepPolicy,
          async (effect) => {
            switch (effect.kind) {
              case "call-rollout-parent": {
                // Parent's minibatch score = the accept/reject baseline; its rollouts are also
                // the feedback proposeCandidate reflects on.
                const parentMini = await rolloutCandidate({
                  optRunId,
                  candidateId: parentId,
                  phase: MINIBATCH,
                  limit: minibatch,
                });
                rolloutsUsed += parentMini.instancesRun;
                return { kind: "parent-scored", outcome: parentMini };
              }
              case "call-propose": {
                const proposed = await proposeCandidate({
                  optRunId,
                  parentCandidateId: parentId,
                  targetModule,
                  iteration,
                });
                childCandidateId = proposed.childCandidateId;
                return { kind: "child-proposed" };
              }
              case "call-rollout-child": {
                // Score the child on the SAME minibatch; the machine gates accept/reject on this.
                const childMini = await rolloutCandidate({
                  optRunId,
                  candidateId: childCandidateId,
                  phase: MINIBATCH,
                  limit: minibatch,
                });
                rolloutsUsed += childMini.instancesRun;
                return { kind: "child-scored", outcome: childMini };
              }
              case "call-rollout-follow-up": {
                const childPareto = await rolloutCandidate({
                  optRunId,
                  candidateId: childCandidateId,
                  phase: PARETO,
                });
                rolloutsUsed += childPareto.instancesRun;
                return { kind: "follow-up-scored", outcome: childPareto };
              }
            }
          },
          // Accepted, but the full-set Pareto eval is what validates and pools it. If the budget
          // can't cover that eval, the machine reports budgetExhausted instead of commanding the
          // follow-up rollout — don't pool an unscored child. Re-read fresh: rolloutsUsed has
          // just been updated by the parent+child minibatch rollouts above by the time this
          // matters (the machine only consults it once the child is scored).
          () => rolloutsUsed + instanceCount <= budgetRollouts
        );

        if (result.budgetExhausted) {
          stopLoop = true; // mirrors the pre-#385 `break` — never pool an unscored child.
        } else if (result.accepted && result.followUp) {
          // Fill the child's full Pareto vector and add it to the pool. Capture the per-instance
          // maxima BEFORE adding so we can tell whether it expands the frontier.
          const maximaBefore = instanceMaxima(pool);
          const childVector: ScoredCandidate = {
            candidateId: childCandidateId,
            instanceScores: result.followUp.instanceScores,
          };
          frontierGain = improvesFrontier(maximaBefore, childVector);
          pool.push(childVector);

          // Headline best tracks the full-set overall score (matches optimization_runs.best_score).
          if (result.followUp.overallScore > bestScore) {
            bestCandidateId = childCandidateId;
            bestScore = result.followUp.overallScore;
          }
        }
      } catch (err) {
        // The known trap (#385): a terminal run-level failure (managed-spend cap, missing
        // provider key, invalid managed agent config) is NOT a per-iteration hiccup to absorb —
        // it will recur on every subsequent iteration, so continuing only burns rollout budget
        // before "completing" on the seed. classifyIterationFailure re-throws it here, past this
        // catch, to the outer catch -> failRun, which marks the run failed with the reason.
        const classification = classifyIterationFailure(err);
        if (classification.rethrow) throw err;
        // One iteration's failure (model proposes nothing usable, a transient rollout error)
        // shouldn't discard the valid pool already built. Log it, count it toward the plateau,
        // and let the loop's own bounds decide whether to continue — unless the failures are the
        // endpoint itself, which the circuit breaker below stops before it burns the budget.
        outcome = classification.outcome;
        log.warn("Optimization iteration failed; continuing with the existing pool", {
          optRunId,
          iteration,
          outcome,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (stopLoop) break;

      // Circuit breaker: only consecutive ENDPOINT failures advance it; a success or a
      // non-endpoint failure resets the streak. Tripping no longer fails the run (#102): the
      // workflow pauses in place and waits for the endpoint to recover, then resumes the loop
      // with the streak reset. Only the max-wait cap inside the pause throws to the outer
      // catch, restoring the pre-#102 fail-with-reason behavior for a dead endpoint.
      const breaker = advanceBreaker(endpointFailures, outcome);
      endpointFailures = breaker.consecutive;
      if (breaker.tripped) {
        await pauseUntilEndpointRecovers();
        endpointFailures = 0;
      }

      // Plateau backstop: a successful iteration that expands the per-instance frontier resets
      // the counter; a successful one that doesn't (rejected/dominated) advances it. A FAILED
      // iteration leaves it unchanged — otherwise a dead endpoint would trip the plateau (and
      // "complete" on the seed) before the circuit breaker above could mark the run failed.
      plateau = advancePlateau(plateau, outcome, frontierGain);
      iters += 1;
    }

    await completeRun({
      optRunId,
      bestCandidateId,
      overallScore: bestScore,
      // seedPareto.overallScore is Candidate 0's full-set score = the lift baseline; rolloutsUsed
      // is the agent invocations spent. Both feed the completion email.
      seedScore: seedPareto.overallScore,
      rolloutsUsed,
    });
  } catch (err) {
    // Record the failure on the run before surfacing it, using the deepest cause message so the
    // reason getOptimizationRun() shows is the real one (e.g. the endpoint error) rather than a
    // generic "Activity task failed" wrapper. failRun carries its own retry policy.
    const message = rootCauseMessage(err);
    await failRun({ optRunId, message });
    // Fail the workflow EXECUTION terminally. A plain re-throw is a non-ApplicationFailure, which
    // Temporal treats as a transient Workflow Task failure and retries forever — the run would be
    // marked failed in Postgres while the workflow spun on replay indefinitely. A non-retryable
    // ApplicationFailure terminates the execution as Failed, matching the run row.
    throw ApplicationFailure.create({
      message,
      type: "OptimizationRunFailed",
      nonRetryable: true,
    });
  }
}
