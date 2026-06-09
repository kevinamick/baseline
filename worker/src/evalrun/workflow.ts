// The Eval Run Workflow (#123). Executes one Eval Run end-to-end as a durable Temporal
// workflow — the flagged alternative to the pgmq poll loop (ADR-0006 fast-follow). Runs
// inside Temporal's deterministic sandbox, so it carries only the run id (plus row indexes)
// and orchestrates Activities — no DB, no Date.now.
//
// Shape: prepare (claim the run + resolve its input rows), then for an agent Connection fan
// out one invokeAgentRow Activity per input row (bounded concurrency), then judge every row
// against the Rubric and persist per-criterion scores/reasoning, then complete (status +
// notifications). Temporal owns retries and resumption — these runs need no external
// stale-reaper (the reaper skips workflow-driven runs).

import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
// Type-only: erased at bundle time, so the DB-touching Activity code never enters the sandbox.
import type * as activities from "./activities.js";
import { rootCauseMessage } from "../temporal/failure.js";
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

// In-run fan-out cap for live agent invocations: bounds load on the customer endpoint
// (mirrors the optimization rollout's in-Activity concurrency cap).
const AGENT_FANOUT_CONCURRENCY = 5;

export async function runEvalWorkflow(input: EvalRunWorkflowInput): Promise<void> {
  const { evalRunId } = input;
  try {
    const prep = await prepareEvalRun(evalRunId);
    // A quiet dataset window: prepare already marked the run 'skipped' (terminal, no
    // email), so the workflow simply completes.
    if (prep.outcome === SKIPPED) return;

    // agent Connection: fill each row's output by invoking the customer endpoint live,
    // fanning out one Activity per row with bounded concurrency. dataset/manual rows
    // arrive complete, so they go straight to judging.
    if (prep.kind === AGENT_KIND) {
      await mapWithConcurrency(prep.rowIndexes, AGENT_FANOUT_CONCURRENCY, (rowIndex) =>
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

// Run `fn` over `items` with at most `limit` in flight, rejecting on the first failure.
// Deterministic (plain promise scheduling, no timers/randomness), so it is sandbox-safe.
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
}
