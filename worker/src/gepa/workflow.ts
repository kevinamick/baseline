// The GEPA Optimization Workflow. Runs inside Temporal's deterministic sandbox, so it
// carries only IDs and orchestrates Activities — no DB, no Date.now, no randomness
// (ADR-0006). Slice #87 is the spine: seed Candidate 0, score it across the frozen instance
// set, and complete with it as the best candidate. Reflective mutation (#88) and Pareto
// selection + the full budgeted loop (#89) replace the straight-line body below.

import { proxyActivities } from "@temporalio/workflow";
// Type-only: erased at bundle time, so the DB-touching Activity code never enters the sandbox.
import type * as activities from "./activities.js";

const { seedRun, rolloutCandidate, completeRun, failRun } = proxyActivities<typeof activities>({
  // A rollout fans out one agent call + judge per frozen instance, so allow generous wall
  // time. maximumAttempts caps retries so a permanently broken endpoint can't loop forever
  // (the real circuit-breaker is #90).
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

export interface OptimizationWorkflowInput {
  optRunId: string;
}

export async function runOptimizationWorkflow(input: OptimizationWorkflowInput): Promise<void> {
  const { optRunId } = input;
  try {
    const { candidateId } = await seedRun(optRunId);
    const { overallScore } = await rolloutCandidate({ optRunId, candidateId, phase: "pareto" });
    await completeRun({ optRunId, bestCandidateId: candidateId, overallScore });
  } catch (err) {
    // Record the failure on the run before surfacing it. failRun carries its own retry
    // policy; if it also fails the workflow still fails loudly (no silent swallow).
    await failRun({ optRunId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
