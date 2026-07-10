// The Simple (Monte Carlo) Optimization Workflow (#316, ADR-0015). A second Optimization Mode
// alongside GEPA, registered as its own workflow type so GEPA stays byte-for-byte unchanged
// (modifying a live workflow risks the replay/versioning of in-flight runs). Runs inside
// Temporal's deterministic sandbox, so it carries only IDs and orchestrates Activities, and its
// only randomness is Math.random() — deterministic here (the SDK seeds and replays it), sourced
// in-workflow and passed to pure helpers in selection.ts / operators.ts.
//
// The loop: seed Candidate 0 (the pasted prompt) and score it on the full Instance set, then each
// round generate N rewrite Candidates from randomly-sampled elites, score each on the full set,
// and keep the top-k by overall score. Terminate on whichever trips first: rollout budget, max
// rounds, or a plateau (rounds with no gain in the best score). No Reflection, no Pareto, no
// minibatch — Simple Mode concentrates on score alone.

import { proxyActivities, log, ApplicationFailure } from "@temporalio/workflow";
import type * as activities from "../gepa/activities.js";
import { topK, sampleElite, type ScoredSimpleCandidate } from "./selection.js";
import { rootCauseMessage } from "../temporal/failure.js";
import { FULL } from "../gepa/phase.js";
import { classifyIterationFailure, shouldContinueLoop } from "../gepa/circuit-breaker.js";
import { driveOptimizationStep, type OptimizationStepPolicy } from "../gepa/optimization-step.js";
import { deriveTerminationReason } from "../gepa/termination-reason.js";

// The rollout Activity invokes the model per instance, so it keeps its own capped retry policy
// (matches GEPA): transient blips absorbed with backoff, maximumAttempts caps the retries.
const { rolloutCandidate } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 3, initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "30s" },
});

// Bookkeeping + a single generation call: a tighter timeout and the default capped retry suffice.
const { seedRun, proposeSimpleCandidate, completeRun, failRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

export interface SimpleOptimizationWorkflowInput {
  optRunId: string;
}

// Population per round (variants generated) and elites kept after each round. Fixed internals,
// not surfaced — Simple Mode's identity is fewer decisions (ADR-0015). Tune here if needed.
const POPULATION_SIZE = 8;
const ELITE_COUNT = 3;

export async function runSimpleOptimizationWorkflow(
  input: SimpleOptimizationWorkflowInput
): Promise<void> {
  const { optRunId } = input;
  try {
    const { candidateId: seedId, instanceCount, modules, budgetRollouts, maxIters, plateauPatience } =
      await seedRun(optRunId);

    // Score the seed on the full frozen set: the pool's first member and the baseline best. Its
    // agent calls count against the budget, faithful to the rollout accounting.
    const seedFull = await rolloutCandidate({ optRunId, candidateId: seedId, phase: FULL });
    const seed: ScoredSimpleCandidate = { candidateId: seedId, score: seedFull.overallScore };
    const pool: ScoredSimpleCandidate[] = [seed];
    let elites: ScoredSimpleCandidate[] = [seed];
    let bestCandidateId = seedId;
    let bestScore = seedFull.overallScore;
    let rolloutsUsed = seedFull.instancesRun;

    // A Managed Agent has exactly one Module; tune it. Nothing to tune (no Modules) or nothing to
    // score against (no instances): complete on the seed.
    const canLoop = modules.length > 0 && instanceCount > 0;
    const targetModule = modules[0];

    let round = 0;
    let plateau = 0;
    let iteration = 0; // per-Candidate sequence, unique within the run (idempotency key)

    // The per-candidate propose -> rollout pipeline is the same pure step machine GEPA drives
    // (#385, ../gepa/optimization-step.ts): no parent rollout (the sampled elite is already
    // scored on the full set), no accept/reject gate (every proposed child is scored and kept —
    // selection happens at the round level via topK below), no follow-up eval (the one rollout
    // already covers the full set).
    const stepPolicy: OptimizationStepPolicy = {
      rolloutParent: false,
      hasFollowUp: false,
      accepts: () => true,
    };

    // Each Candidate is scored on the full set (instanceCount rollouts). Only generate another
    // variant while its guaranteed cost still fits under the budget ceiling.
    while (
      canLoop &&
      shouldContinueLoop({
        rolloutsUsed,
        iterationCost: instanceCount,
        budgetRollouts,
        iters: round,
        maxIters,
        plateau,
        plateauPatience,
      })
    ) {
      round += 1;
      let improvedThisRound = false;
      const fresh: ScoredSimpleCandidate[] = [];

      for (let v = 0; v < POPULATION_SIZE; v += 1) {
        // Stop the round the moment the next full-set scoring would overrun the budget.
        if (rolloutsUsed + instanceCount > budgetRollouts) break;
        try {
          // Sample an elite to rewrite (uniform; Math.random is replay-safe).
          const parentId = sampleElite(elites, Math.random());
          iteration += 1;

          // Drive the shared step machine to completion (optimization-step.ts): `execute` is the
          // only Mode-specific wiring left. Every Activity call and argument here is identical to
          // the pre-#385 inline sequence (propose, then roll the child out on the full set); only
          // the decision of "what's next" moved into the machine — a no-op decision for Simple
          // (no gate, no follow-up), but the same shared shape GEPA drives.
          let childCandidateId = "";
          const result = await driveOptimizationStep(
            stepPolicy,
            async (effect) => {
              switch (effect.kind) {
                case "call-propose": {
                  const proposed = await proposeSimpleCandidate({
                    optRunId,
                    parentCandidateId: parentId,
                    targetModule,
                    round,
                    iteration,
                    operatorSeed: Math.random(),
                  });
                  childCandidateId = proposed.childCandidateId;
                  return { kind: "child-proposed" };
                }
                case "call-rollout-child": {
                  const childFull = await rolloutCandidate({
                    optRunId,
                    candidateId: childCandidateId,
                    phase: FULL,
                  });
                  rolloutsUsed += childFull.instancesRun;
                  return { kind: "child-scored", outcome: childFull };
                }
                // Simple's policy never commands these (rolloutParent/hasFollowUp are false).
                case "call-rollout-parent":
                case "call-rollout-follow-up":
                  throw new Error(`unreachable for Simple Mode: ${effect.kind}`);
              }
            },
            () => false // policy.hasFollowUp is false, so this is never consulted
          );

          const scored: ScoredSimpleCandidate = {
            candidateId: childCandidateId,
            score: result.child.overallScore,
          };
          fresh.push(scored);
          pool.push(scored);
          if (result.child.overallScore > bestScore) {
            bestCandidateId = childCandidateId;
            bestScore = result.child.overallScore;
            improvedThisRound = true;
          }
        } catch (err) {
          // Any terminal run failure (#415: widened from managed-spend-only) — a managed-spend
          // block (cap reached mid-run, payment blocked, unpriced model), an invalid/missing
          // managed-agent config, or a missing provider key — must fail the whole run, not be
          // absorbed: continuing would burn budget (and, for managed runs, real spend) on variants
          // that can never succeed and then "complete" on the seed as if the run worked. The rollout
          // and propose Activities are shared with GEPA, so they can throw any of these markers;
          // `classifyIterationFailure` (circuit-breaker.ts) is the one place that decision lives.
          // Re-throw to the outer catch -> failRun (#291, #415).
          if (classifyIterationFailure(err).rethrow) throw err;
          // One variant's failure (empty generation, a transient rollout error) shouldn't discard
          // the elites already built. Log it and let the loop's bounds decide. There is no endpoint
          // circuit breaker — Simple Mode runs only on Managed Agents, so there's no customer
          // endpoint to fail; transient model blips are absorbed by the Activity's own retries.
          log.warn("Simple optimization variant failed; continuing with the existing elites", {
            optRunId,
            round,
            iteration,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Keep the top-k by overall score across the surviving elites and this round's fresh
      // Candidates (old non-elites can't beat an elite, so they need no reconsideration).
      elites = topK([...elites, ...fresh], ELITE_COUNT);

      // Plateau backstop (round-level): a round that produced a new global best resets the streak;
      // a round that didn't advances it. A round where every variant failed produced no best, so it
      // advances too — there's no circuit breaker here to mask, so "no improvement" is the whole rule.
      plateau = improvedThisRound ? 0 : plateau + 1;
    }

    // Why the run ended without ever entering round 1, if that's what happened (#469) — see
    // gepa/workflow.ts's identical call for the full rationale on why this is a direct edit with
    // no patched()/versioning gate (it only changes completeRun's input payload, not the
    // Activity call sequence a replay pins against).
    const terminationReason = deriveTerminationReason({
      modulesCount: modules.length,
      instanceCount,
      loopIterations: round,
    });

    await completeRun({
      optRunId,
      bestCandidateId,
      overallScore: bestScore,
      seedScore: seedFull.overallScore,
      rolloutsUsed,
      terminationReason,
    });
  } catch (err) {
    const message = rootCauseMessage(err);
    await failRun({ optRunId, message });
    // Terminate the execution as Failed (matching the run row). A plain re-throw is a
    // non-ApplicationFailure, which Temporal retries forever; a non-retryable ApplicationFailure
    // lands the execution Failed.
    throw ApplicationFailure.create({ message, type: "OptimizationRunFailed", nonRetryable: true });
  }
}

