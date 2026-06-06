// The GEPA Optimization Workflow (arXiv:2507.19457). Runs inside Temporal's deterministic
// sandbox, so it carries only IDs and orchestrates Activities — no DB, no Date.now (ADR-0006).
// Math.random() IS deterministic here (the SDK seeds and replays it), so the Pareto sampler's
// random draw is sourced in-workflow and passed to a pure helper.
//
// The loop: seed Candidate 0 and score it on the full set, then iterate — Pareto-sample a
// parent from the frontier, round-robin a target Module, mutate it, and keep the child only if
// it beats the parent on a minibatch; an accepted child is scored on the full set and joins the
// pool. Terminate on whichever trips first: rollout budget, max iterations, or a plateau.

import { proxyActivities, log, ApplicationFailure } from "@temporalio/workflow";
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
  isEndpointFailure,
  type IterationOutcome,
} from "./circuit-breaker.js";

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

// Bookkeeping Activities (seed / propose / complete / fail): pure Postgres or a single
// reflection call, so a tighter timeout and the default capped retry are plenty.
const { seedRun, proposeCandidate, completeRun, failRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

export interface OptimizationWorkflowInput {
  optRunId: string;
}

// Instances scored in each accept/reject minibatch test (D9 sizing). The full frozen set is
// always used for a Candidate's Pareto score vector.
const MINIBATCH_SIZE = 5;

export async function runOptimizationWorkflow(input: OptimizationWorkflowInput): Promise<void> {
  const { optRunId } = input;
  try {
    const { candidateId: seedId, instanceCount, modules, budgetRollouts, maxIters, plateauPatience } =
      await seedRun(optRunId);

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

    let iters = 0;
    let plateau = 0;
    // Circuit breaker (#90): consecutive iterations whose failure is the customer endpoint. A
    // sustained outage trips it and aborts the run, rather than retrying to budget exhaustion.
    let endpointFailures = 0;
    // budget_rollouts is a hard ceiling on agent invocations (D8), so only enter an iteration
    // when its guaranteed cost — the parent + child minibatch pair — still fits. The optional
    // full-set Pareto eval on an accepted child is gated separately below before it's spent.
    while (
      canLoop &&
      rolloutsUsed + 2 * minibatch <= budgetRollouts &&
      iters < maxIters &&
      (plateauPatience == null || plateau < plateauPatience)
    ) {
      const iteration = iters + 1; // 1-based, unique per run -> child identity (idempotent retries)
      const targetModule = modules[iters % modules.length]; // round-robin the Module to mutate
      let frontierGain = false;
      let outcome: IterationOutcome = "ok";

      try {
        // Pareto-sample the parent from the frontier (win-weighted; Math.random is replay-safe).
        const parentId = sampleParent(pool, Math.random());

        // Parent's minibatch score = the accept/reject baseline; its rollouts are also the
        // feedback proposeCandidate reflects on.
        const parentMini = await rolloutCandidate({
          optRunId,
          candidateId: parentId,
          phase: MINIBATCH,
          limit: minibatch,
        });
        rolloutsUsed += parentMini.instancesRun;

        const { childCandidateId } = await proposeCandidate({
          optRunId,
          parentCandidateId: parentId,
          targetModule,
          iteration,
        });

        // Score the child on the SAME minibatch; accept only if it strictly beats the parent.
        const childMini = await rolloutCandidate({
          optRunId,
          candidateId: childCandidateId,
          phase: MINIBATCH,
          limit: minibatch,
        });
        rolloutsUsed += childMini.instancesRun;

        if (accepts(childMini.overallScore, parentMini.overallScore)) {
          // Accepted, but the full-set Pareto eval is what validates and pools it. If the
          // budget can't cover that eval, stop rather than overrun the ceiling — and don't
          // pool an unscored child. The minibatch win is real but can't be acted on.
          if (rolloutsUsed + instanceCount > budgetRollouts) break;

          // Fill the child's full Pareto vector and add it to the pool. Capture the per-instance
          // maxima BEFORE adding so we can tell whether it expands the frontier.
          const maximaBefore = instanceMaxima(pool);
          const childPareto = await rolloutCandidate({
            optRunId,
            candidateId: childCandidateId,
            phase: PARETO,
          });
          rolloutsUsed += childPareto.instancesRun;

          const childVector: ScoredCandidate = {
            candidateId: childCandidateId,
            instanceScores: childPareto.instanceScores,
          };
          frontierGain = improvesFrontier(maximaBefore, childVector);
          pool.push(childVector);

          // Headline best tracks the full-set overall score (matches optimization_runs.best_score).
          if (childPareto.overallScore > bestScore) {
            bestCandidateId = childCandidateId;
            bestScore = childPareto.overallScore;
          }
        }
      } catch (err) {
        // One iteration's failure (model proposes nothing usable, a transient rollout error)
        // shouldn't discard the valid pool already built. Log it, count it toward the plateau,
        // and let the loop's own bounds decide whether to continue — unless the failures are the
        // endpoint itself, which the circuit breaker below stops before it burns the budget.
        outcome = isEndpointFailure(err) ? "endpoint-failure" : "other-failure";
        log.warn("Optimization iteration failed; continuing with the existing pool", {
          optRunId,
          iteration,
          outcome,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Circuit breaker: only consecutive ENDPOINT failures advance it; a success or a
      // non-endpoint failure resets the streak. Tripping throws to the outer catch, which marks
      // the run failed with a clear reason — not after the whole budget is spent.
      const breaker = advanceBreaker(endpointFailures, outcome);
      endpointFailures = breaker.consecutive;
      if (breaker.tripped) {
        throw new Error(
          `Circuit breaker tripped: the agent endpoint failed on ${endpointFailures} consecutive iterations — aborting the run before exhausting the budget`
        );
      }

      // Plateau backstop: a successful iteration that expands the per-instance frontier resets
      // the counter; a successful one that doesn't (rejected/dominated) advances it. A FAILED
      // iteration leaves it unchanged — otherwise a dead endpoint would trip the plateau (and
      // "complete" on the seed) before the circuit breaker above could mark the run failed.
      plateau = advancePlateau(plateau, outcome, frontierGain);
      iters += 1;
    }

    await completeRun({ optRunId, bestCandidateId, overallScore: bestScore });
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

// Unwrap an error to its deepest `cause` message. Temporal wraps an Activity's ApplicationFailure
// in an ActivityFailure whose own message is generic; the actionable text is on the cause.
function rootCauseMessage(err: unknown): string {
  let cur: unknown = err;
  let message = err instanceof Error ? err.message : String(err);
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const { message: m, cause } = cur as { message?: unknown; cause?: unknown };
    if (typeof m === "string" && m.length > 0) message = m;
    cur = cause;
  }
  return message;
}
