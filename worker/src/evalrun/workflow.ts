// The Eval Run Workflow (#123). Executes one Eval Run end-to-end as a durable Temporal
// workflow — the SOLE eval-run execution path (ADR-0006; no pgmq executor, no flag). Runs
// inside Temporal's deterministic sandbox, so it carries only the run id (plus row indexes)
// and orchestrates Activities — no DB, no Date.now.
//
// Shape: prepare (claim the run + resolve its input rows + the claim-time billing reserve gate
// for scheduled runs), then for an agent Connection fan out one invokeAgentRow Activity per
// input row (bounded concurrency), then judge every row against the Rubric and persist
// per-criterion scores/reasoning (resolving + metering the judge key inside the Activity), then
// complete (status + point settlement + notifications). The Activities carry all billing —
// judge/target key resolution, managed metering, and point settlement on every terminal
// outcome. Temporal owns retries and resumption while the workflow is alive; a workflow that
// DIES without writing a terminal status (terminal-Activity retries exhausted, operator
// terminate, retention expiry) is recovered by the worker's orphaned-workflow sweep
// (worker.ts reapOrphanedWorkflowRuns) — the SQL reaper skips workflow-stamped runs.

import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
// Type-only: erased at bundle time, so the DB-touching Activity code never enters the sandbox.
import type * as activities from "./activities.js";
import { rootCauseMessage } from "../temporal/failure.js";
// Pure (no Node imports, no timers, no randomness), so it bundles into the deterministic
// sandbox the same way kind.js and temporal/failure.js do. Fail-fast: the first rejection
// stops surviving runners from pulling new items, so a failed run does not keep invoking the
// customer's live agent endpoint for the rest of the queue while the workflow is already
// unwinding to failEvalRun.
import { mapWithConcurrency } from "../concurrency.js";
import { AGENT_KIND, SKIPPED } from "./kind.js";

// prepare may fetch a dataset window from the customer's source; judge scores every row
// through the LLM judge, so it gets the same generous ceiling as an optimization rollout.
const { prepareEvalRun, judgeEvalRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 3 },
});

// Per-row agent invocation: capped retries with backoff absorb transient endpoint blips;
// exhaustion fails the run with the endpoint's real error as the reason.
const { invokeAgentRow } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

// Terminal bookkeeping: pure Postgres + best-effort email.
const { completeEvalRun, failEvalRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

export interface EvalRunWorkflowInput {
  evalRunId: string;
}

export async function runEvalWorkflow(input: EvalRunWorkflowInput): Promise<void> {
  const { evalRunId } = input;
  try {
    const prep = await prepareEvalRun(evalRunId);
    // A quiet dataset window: prepare already marked the run 'skipped' (terminal, no
    // email), so the workflow simply completes.
    if (prep.outcome === SKIPPED) return;

    // agent Connection: fill each row's output by invoking the customer endpoint live,
    // fanning out one Activity per row with bounded concurrency. The cap (EVAL_AGENT_FANOUT_
    // CONCURRENCY, default 5) is resolved by prepareEvalRun in Activity/Node context and returned
    // here — reading it from the workflow sandbox would be non-deterministic, so the value rides
    // the Activity result (recorded in history, replay-safe). dataset/manual rows arrive complete,
    // so they go straight to judging.
    if (prep.kind === AGENT_KIND) {
      await mapWithConcurrency(prep.rowIndexes, prep.agentFanoutConcurrency, (rowIndex) =>
        invokeAgentRow({ evalRunId, rowIndex })
      );
    }

    const { overallScore, rowCount } = await judgeEvalRun({ evalRunId });
    await completeEvalRun({ evalRunId, overallScore, rowCount });
  } catch (err) {
    // Record the failure on the run before surfacing it, using the deepest cause message so
    // the reason shown in the app is the real one (e.g. the endpoint error) rather than a
    // generic "Activity task failed" wrapper.
    const message = rootCauseMessage(err);
    await failEvalRun({ evalRunId, message });
    // Fail the workflow EXECUTION terminally. A plain re-throw is a non-ApplicationFailure,
    // which Temporal treats as a transient Workflow Task failure and retries forever — the
    // run would be marked failed in Postgres while the workflow spun on replay indefinitely.
    throw ApplicationFailure.create({
      message,
      type: "EvalRunFailed",
      nonRetryable: true,
    });
  }
}
