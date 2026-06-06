// The GEPA Optimization Workflow (arXiv:2507.19457). Runs inside Temporal's deterministic
// sandbox, so it carries only IDs and orchestrates Activities — no DB, no Date.now (ADR-0006).
// Math.random() IS deterministic here (the SDK seeds and replays it), so the Pareto sampler's
// random draw is sourced in-workflow and passed to a pure helper.
//
// The loop: seed Candidate 0 and score it on the full set, then iterate — Pareto-sample a
// parent from the frontier, round-robin a target Module, mutate it, and keep the child only if
// it beats the parent on a minibatch; an accepted child is scored on the full set and joins the
// pool. Terminate on whichever trips first: rollout budget, max iterations, or a plateau.

import { proxyActivities, log } from "@temporalio/workflow";
// Type-only: erased at bundle time, so the DB-touching Activity code never enters the sandbox.
import type * as activities from "./activities.js";
import {
  accepts,
  improvesFrontier,
  instanceMaxima,
  sampleParent,
  type ScoredCandidate,
} from "./pareto.js";

const { seedRun, rolloutCandidate, proposeCandidate, completeRun, failRun } = proxyActivities<
  typeof activities
>({
  // A rollout fans out one agent call + judge per instance, so allow generous wall time.
  // maximumAttempts caps retries so a permanently broken endpoint can't loop forever (the
  // dedicated circuit-breaker is #90).
  startToCloseTimeout: "30 minutes",
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
    const seedPareto = await rolloutCandidate({ optRunId, candidateId: seedId, phase: "pareto" });
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

      try {
        // Pareto-sample the parent from the frontier (win-weighted; Math.random is replay-safe).
        const parentId = sampleParent(pool, Math.random());

        // Parent's minibatch score = the accept/reject baseline; its rollouts are also the
        // feedback proposeCandidate reflects on.
        const parentMini = await rolloutCandidate({
          optRunId,
          candidateId: parentId,
          phase: "minibatch",
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
          phase: "minibatch",
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
            phase: "pareto",
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
        // and let the loop's own bounds decide whether to continue. A broken endpoint burning
        // the whole budget is #90's circuit breaker.
        log.warn("Optimization iteration failed; continuing with the existing pool", {
          optRunId,
          iteration,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Plateau backstop: an iteration that expands the per-instance frontier resets the
      // counter; one that doesn't (rejected, dominated, or failed) advances it.
      plateau = frontierGain ? 0 : plateau + 1;
      iters += 1;
    }

    await completeRun({ optRunId, bestCandidateId, overallScore: bestScore });
  } catch (err) {
    // Record the failure on the run before surfacing it. failRun carries its own retry policy;
    // if it also fails the workflow still fails loudly (no silent swallow).
    await failRun({ optRunId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
