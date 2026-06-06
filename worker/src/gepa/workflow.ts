// The GEPA Optimization Workflow. Runs inside Temporal's deterministic sandbox, so it
// carries only IDs and orchestrates Activities — no DB, no Date.now, no randomness
// (ADR-0006). Slice #87 seeded Candidate 0 and scored it. Slice #88 adds ONE reflective-
// mutation iteration: improve a Module, keep the child only if it beats its parent on the
// minibatch. Pareto selection + the full budgeted loop (#89) replace the straight-line body.

import { proxyActivities, log } from "@temporalio/workflow";
// Type-only: erased at bundle time, so the DB-touching Activity code never enters the sandbox.
import type * as activities from "./activities.js";

const { seedRun, rolloutCandidate, proposeCandidate, completeRun, failRun } = proxyActivities<
  typeof activities
>({
  // A rollout fans out one agent call + judge per frozen instance, so allow generous wall
  // time. maximumAttempts caps retries so a permanently broken endpoint can't loop forever
  // (the real circuit-breaker is #90).
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

export interface OptimizationWorkflowInput {
  optRunId: string;
}

// Instances scored in the accept/reject minibatch test (D9 sizing). The full frozen set is
// always used for the Pareto score vector.
const MINIBATCH_SIZE = 5;

export async function runOptimizationWorkflow(input: OptimizationWorkflowInput): Promise<void> {
  const { optRunId } = input;
  try {
    const { candidateId: seedId, instanceCount, modules } = await seedRun(optRunId);

    // Score the seed Candidate on the full frozen (Pareto) set — the baseline best.
    const seedPareto = await rolloutCandidate({ optRunId, candidateId: seedId, phase: "pareto" });
    let bestCandidateId = seedId;
    let bestScore = seedPareto.overallScore;

    // One reflective-mutation iteration. Skipped when there's nothing to tune (no Modules)
    // or nothing to score against (no instances) — the run then completes with the seed.
    //
    // The iteration is best-effort: the seed has already been validly scored, so a failure
    // here (a model that proposes nothing usable, a transient rollout error) means "no
    // improvement this run", not a failed run. We log and complete with the seed rather than
    // discarding a valid result. A broken endpoint that burns the budget is #90's circuit
    // breaker; the budgeted loop that turns this into many iterations is #89.
    if (modules.length > 0 && instanceCount > 0) {
      try {
        const targetModule = modules[0];
        const limit = Math.min(MINIBATCH_SIZE, instanceCount);

        // Parent's minibatch score = the accept/reject baseline. Its rollouts are also the
        // feedback proposeCandidate reflects on.
        const parentMini = await rolloutCandidate({
          optRunId,
          candidateId: seedId,
          phase: "minibatch",
          limit,
        });

        const { childCandidateId } = await proposeCandidate({
          optRunId,
          parentCandidateId: seedId,
          targetModule,
        });

        // Score the child on the SAME minibatch; accept only if it strictly beats the parent.
        const childMini = await rolloutCandidate({
          optRunId,
          candidateId: childCandidateId,
          phase: "minibatch",
          limit,
        });

        if (childMini.overallScore > parentMini.overallScore) {
          // Accepted: fill the child's full Pareto score vector and promote it if it's also
          // the best on the full set (the minibatch win doesn't guarantee a Pareto win).
          const childPareto = await rolloutCandidate({
            optRunId,
            candidateId: childCandidateId,
            phase: "pareto",
          });
          if (childPareto.overallScore > bestScore) {
            bestCandidateId = childCandidateId;
            bestScore = childPareto.overallScore;
          }
        }
      } catch (err) {
        log.warn("Reflective-mutation iteration failed; completing with the seed candidate", {
          optRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await completeRun({ optRunId, bestCandidateId, overallScore: bestScore });
  } catch (err) {
    // Record the failure on the run before surfacing it. failRun carries its own retry
    // policy; if it also fails the workflow still fails loudly (no silent swallow).
    await failRun({ optRunId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
