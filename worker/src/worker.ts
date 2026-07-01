import { createClient } from "@supabase/supabase-js";
import { createServer } from "http";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { isLlmProvider } from "./providers/provider-list.js";
import { initTelemetry, captureException } from "./telemetry.js";
import { log, shutdownLogging } from "./log.js";
import { runWithLogContext, setLogContext, runElapsedMs } from "./log-context.js";
import { startTemporalWorker } from "./temporal/worker.js";
import { getTemporalClient } from "./temporal/client.js";
import { OPTIMIZATION_TASK_QUEUE } from "./temporal/connection.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const POLL_INTERVAL_MS = 5_000;
// The worker runs always-on (no idle-exit, no scale-to-zero). Temporal's model is pull-based:
// the worker dials Temporal and long-polls its task queues — nothing external can wake a
// stopped worker. A worker that self-exits on idle would silently stall every Temporal-driven
// workflow until the next inbound HTTP wake, which Temporal never sends. So the process must
// stay up. See ADR-0006 and worker/fly.toml. (The pgmq wake endpoint below only nudges the
// scheduling dispatcher to pick up new eval-run work promptly.)
const OPT_STALE_THRESHOLD_MINUTES = 30;
const EVAL_STALE_THRESHOLD_MINUTES = 10;
const REAP_EVERY_N_POLLS = 12; // ~1 minute at 5s intervals

// HTTP wake endpoint — lets the app server nudge the pgmq poll loop to pick up new scheduled
// eval-run work without waiting out the poll interval. Requires WORKER_WAKE_SECRET to match the
// Authorization: Bearer header.
let wakeReceived = false;

function startWakeServer() {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  const secret = process.env.WORKER_WAKE_SECRET;
  const server = createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (!secret || auth !== `Bearer ${secret}`) {
      res.writeHead(401).end();
      return;
    }
    wakeReceived = true;
    res.writeHead(200).end();
  });
  server.listen(port, () =>
    log.info("Wake endpoint listening", {
      event: "worker.wake_listening",
      port,
    }),
  );
  return server;
}

// The pgmq poll loop is now a thin DISPATCHER (#123, ADR-0006, Option A): pg_cron can't call
// Temporal directly, so a scheduled eval run is enqueued onto pgmq and the worker starts its
// durable `runEvalWorkflow` here, then acks the message. It runs NO eval logic — claiming,
// dataset fetch, agent invocation, judging, billing (the claim-time reserve gate, judge/target
// metering), and point settlement all live in the workflow's Activities (worker/src/evalrun/).
// A stable workflowId (`eval-<runId>`) makes a redelivered message a harmless already-started
// no-op.
export async function dispatchEvalRun(msgId: bigint, runId: string): Promise<void> {
  const { data: run, error: runError } = await supabase
    .from("eval_runs")
    .select("id, status, workflow_id")
    .eq("id", runId)
    .maybeSingle();

  if (runError) {
    // A transient read failure: leave the message on the queue (don't ack) so a later poll
    // retries the dispatch once the visibility timeout redelivers it.
    log.error("Failed to fetch run for dispatch — message will be redelivered", {
      event: "eval_run.dispatch_fetch_failed",
      run_id: runId,
      error: runError,
    });
    return;
  }

  if (!run) {
    // The run row is gone (e.g. rolled back at creation). Nothing to execute — ack so the
    // message doesn't redeliver forever.
    log.warn("Dispatch skipped — run not found", {
      event: "eval_run.dispatch_missing",
      run_id: runId,
    });
    await ackMessage(msgId, runId);
    return;
  }

  // Already terminal: the workflow ran (or the run was settled/cancelled). Don't re-dispatch;
  // just ack the redelivered message.
  if (run.status === "completed" || run.status === "failed" || run.status === "skipped") {
    await ackMessage(msgId, runId);
    return;
  }

  // Stamp a stable workflow_id BEFORE starting so the stale-run reaper never mistakes a
  // freshly-dispatched run for a stuck one, and so a redelivered message resolves the same id.
  const workflowId = `eval-${runId}`;
  if (run.workflow_id !== workflowId) {
    const { error: stampError } = await supabase
      .from("eval_runs")
      .update({ workflow_id: workflowId })
      .eq("id", runId);
    if (stampError) {
      // Don't ack: retry the dispatch on the next poll rather than start a workflow whose id
      // isn't recorded on the run.
      log.error("Failed to stamp workflow_id — message will be redelivered", {
        event: "eval_run.dispatch_stamp_failed",
        run_id: runId,
        error: stampError,
      });
      return;
    }
  }

  try {
    const client = await getTemporalClient();
    await client.workflow.start("runEvalWorkflow", {
      taskQueue: OPTIMIZATION_TASK_QUEUE,
      workflowId,
      args: [{ evalRunId: runId }],
    });
    log.info("Scheduled eval run workflow started", {
      event: "eval_run.workflow_started",
      run_id: runId,
      workflow_id: workflowId,
      duration_ms: runElapsedMs(),
    });
  } catch (err) {
    // A redelivered message whose workflow is already running is the idempotent happy path:
    // the workflow owns execution, so ack and move on.
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      await ackMessage(msgId, runId);
      return;
    }
    // A real start failure (Temporal unreachable): leave the message queued so a later poll
    // retries. Temporal is mandatory, so a persistent outage stalls dispatch until it recovers
    // rather than dropping the run.
    captureException(err, { run_id: runId, context: "dispatchEvalRun" });
    log.error("Failed to start scheduled eval run workflow — message will be redelivered", {
      event: "eval_run.workflow_start_failed",
      run_id: runId,
      workflow_id: workflowId,
      error: err,
    });
    return;
  }

  await ackMessage(msgId, runId);
}

async function ackMessage(msgId: bigint, runId: string): Promise<void> {
  const { error } = await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
  if (error) {
    log.error("Failed to ack eval run message — message may be redelivered", {
      event: "eval_run.ack_failed",
      run_id: runId,
      msg_id: String(msgId),
      error,
    });
  }
}

// Reap eval runs stranded 'running' — inert now that Temporal owns retries/resumption for every
// eval run (a running run is workflow-driven), but kept as a safety net for a run that somehow
// reaches 'running' without a live workflow. Failures are logged, never thrown.
export async function reapStaleRuns() {
  const { data, error } = await supabase.rpc("reap_stale_eval_runs", {
    p_threshold_minutes: EVAL_STALE_THRESHOLD_MINUTES,
  });
  if (error) {
    captureException(error, { context: "reapStaleRuns" });
    log.error("Stale run reaper error", {
      event: "eval_run.reap_failed",
      error,
    });
  } else if (data > 0) {
    log.info("Reaped stale eval run(s)", {
      event: "eval_run.reaped",
      count: data,
    });
  }
}

// Reap Optimization Runs stranded 'running' by a crashed worker, freeing the org's one-active
// slot (#90). Failures are logged, never thrown.
export async function reapStaleOptimizationRuns() {
  const { data, error } = await supabase.rpc("reap_stale_optimization_runs", {
    p_threshold_minutes: OPT_STALE_THRESHOLD_MINUTES,
  });
  if (error) {
    captureException(error, { context: "reapStaleOptimizationRuns" });
    log.error("Stale optimization run reaper error", {
      event: "optimization_run.reap_failed",
      error,
    });
  } else if (data > 0) {
    log.info("Reaped stale optimization run(s)", {
      event: "optimization_run.reaped",
      count: data,
    });
  }
}

export async function poll(): Promise<boolean> {
  const { data, error } = await supabase.rpc("dequeue_eval_run_message", {
    vt_seconds: 60,
  });

  if (error) {
    captureException(error, { context: "poll" });
    log.error("Poll error", { event: "worker.poll_failed", error });
    return false;
  }

  if (!data || data.length === 0) return false;

  const { msg_id, run_id } = data[0] as { msg_id: bigint; run_id: string };
  log.info("Dispatching run", {
    event: "eval_run.dequeued",
    run_id,
    msg_id: String(msg_id),
  });
  // Open a run-scoped log context so the dispatch records auto-correlate by run_id. The
  // execution logs (claim, judge, settlement) are emitted inside the workflow's Activities,
  // which open their own run scope (temporal/activity-log-context.ts).
  await runWithLogContext({ run_id, started_at_ms: Date.now() }, async () => {
    // Best-effort org correlation for the dispatch records.
    const { data: run } = await supabase
      .from("eval_runs")
      .select("rubrics!inner(org_id)")
      .eq("id", run_id)
      .maybeSingle<{ rubrics: { org_id: string } | { org_id: string }[] }>();
    const rubric = run
      ? Array.isArray(run.rubrics)
        ? run.rubrics[0]
        : run.rubrics
      : null;
    if (rubric?.org_id) setLogContext({ org_id: rubric.org_id });
    await dispatchEvalRun(msg_id, run_id);
  });
  return true;
}

// Process-level fatal-error logging. An `uncaughtException`, or an `unhandledRejection` that
// escapes the poll loop's own catch, would otherwise terminate the worker with only Node's
// default stderr dump — never reaching the queryable PostHog Logs stream or error tracking.
// This ships a structured `log.error` plus an error-tracking record for the crash, mirroring
// the app's onRequestError hook (src/instrumentation.ts) that does the same for server errors.
// Best-effort and never throws, so a logging failure can't mask the original crash.
export function reportFatalError(
  kind: "uncaughtException" | "unhandledRejection",
  error: unknown,
): void {
  const uncaught = kind === "uncaughtException";
  try {
    captureException(error, { context: kind });
  } catch {
    // never let the crash-reporter itself throw
  }
  log.error(uncaught ? "Uncaught exception" : "Unhandled promise rejection", {
    event: uncaught ? "worker.uncaught_exception" : "worker.unhandled_rejection",
    error,
  });
}

// Wire the fatal-error handlers. We still exit(1) after logging: Node's default for both
// events is to terminate the process, and letting Fly restart a worker that is in an undefined
// state is safer than soldiering on. A hard timeout guarantees exit even if the log drain hangs.
function registerProcessErrorHandlers(): void {
  let crashing = false;
  const onFatal = (kind: "uncaughtException" | "unhandledRejection", error: unknown) => {
    if (crashing) return; // a second fatal during drain shouldn't re-enter
    crashing = true;
    reportFatalError(kind, error);
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    // Drain buffered PostHog log records before exiting, like the shutdown handler does.
    shutdownLogging().finally(() => process.exit(1));
  };
  process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => onFatal("unhandledRejection", reason));
}

async function main() {
  // Register fatal-error handlers first so a crash anywhere in startup is still logged.
  registerProcessErrorHandlers();
  initTelemetry();
  // Fail fast on a misconfigured LLM_PROVIDER name (the per-run providers are built later inside
  // the workflow's Activities, each with the Team's resolved key).
  const providerName = process.env.LLM_PROVIDER ?? "anthropic";
  if (!isLlmProvider(providerName)) {
    throw new Error(`Unknown LLM_PROVIDER: ${providerName}`);
  }
  const server = startWakeServer();
  // Temporal is the SOLE executor for eval and optimization runs (#123, ADR-0006), so the
  // Temporal worker is unconditional — a failure to register it means the process can't do its
  // job. Throw so Fly restarts rather than run a dispatcher whose workflows never execute.
  const temporalWorker = await startTemporalWorker();
  if (!temporalWorker) {
    throw new Error(
      "Temporal worker failed to register — refusing to run without an executor",
    );
  }
  log.info("Worker started", {
    event: "worker.started",
    provider: providerName,
    temporal_enabled: true,
  });

  // The worker no longer self-exits on idle, so a deploy/restart (Fly sends SIGINT/SIGTERM) is
  // now the normal way it goes down. Shut down cleanly so Temporal sees the worker leave its
  // task queue and drains in-flight activities, rather than being killed mid-rollout. A hard
  // timeout guarantees we exit even if a drain hangs (Fly SIGKILLs after its grace period anyway).
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("Shutdown signal received — shutting down", {
        event: "worker.shutdown",
        signal,
      });
      const forceExit = setTimeout(() => process.exit(0), 10_000);
      forceExit.unref();
      server.close();
      Promise.resolve(temporalWorker?.shutdown())
        .catch((err) =>
          log.error("Temporal worker shutdown failed", {
            event: "temporal.worker_shutdown_failed",
            error: err,
          }),
        )
        // Drain buffered PostHog log records before the process exits.
        .then(() => shutdownLogging())
        .finally(() => process.exit(0));
    });
  }

  let pollCount = 0;
  while (!shuttingDown) {
    if (pollCount % REAP_EVERY_N_POLLS === 0) {
      await reapStaleRuns();
      await reapStaleOptimizationRuns();
    }
    pollCount++;

    // Stop claiming new pgmq work once shutdown has begun.
    if (shuttingDown) break;
    await poll().catch((err) => {
      // Swallow so a transient DB error can't crash the always-on loop.
      log.error("Poll loop error", {
        event: "worker.poll_loop_error",
        error: err,
      });
    });

    // Skip the poll-interval wait when the app server has signalled new work.
    if (wakeReceived) {
      wakeReceived = false;
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (!process.env.VITEST) {
  main();
}
