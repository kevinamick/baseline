// Registers a Temporal worker inside the existing worker process, alongside the pgmq poll
// loop (coexistence — ADR-0006). Gated behind TEMPORAL_ENABLED so that, until Temporal is
// configured, this is a no-op and the process runs exactly as it does today.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { getDataConverter } from "./codec.js";
import { getTemporalEnv, temporalEnabled } from "./connection.js";
import { activityLogContextInterceptors } from "./activity-log-context.js";
import { log } from "../log.js";

// The worker bundler needs the on-disk path to the workflows module. Under tsx (dev) that
// is the .ts source; after `tsc` build it is the emitted .js in dist. Resolve whichever
// exists so the same code works in both.
function resolveWorkflowsPath(): string {
  const tsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
  return existsSync(tsPath)
    ? tsPath
    : fileURLToPath(new URL("./workflows.js", import.meta.url));
}

// Connect with a short bounded retry so a worker that boots a beat before the Temporal
// server is listening (common under `npm run dev`, where both start together) doesn't
// give up and fall back to pgmq-only. Also smooths transient connection blips in prod.
async function connectWithRetry(
  options: Parameters<typeof NativeConnection.connect>[0],
  attempts = 10,
  delayMs = 1_000
): Promise<NativeConnection> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await NativeConnection.connect(options);
    } catch (err) {
      if (attempt >= attempts) throw err;
      log.info("Temporal not reachable yet — retrying", {
        event: "temporal.connect_retry",
        attempt,
        attempts,
        delay_ms: delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function startTemporalWorker(): Promise<Worker | null> {
  if (!temporalEnabled()) return null;

  const { address, namespace, tls, taskQueue } = getTemporalEnv();
  const connection = await connectWithRetry({ address, tls });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: resolveWorkflowsPath(),
    activities,
    dataConverter: getDataConverter(),
    // Open an ambient log-context scope per Activity so optimization-run logs from deep call
    // sites auto-correlate by opt_run_id (mirrors the eval-run scope in worker.ts).
    interceptors: { activity: [activityLogContextInterceptors] },
  });

  // worker.run() resolves only on shutdown; let it run in the background next to the poll
  // loop. A crash here must not take down eval-run processing.
  worker.run().catch((err) => {
    log.error("Temporal worker stopped unexpectedly", {
      event: "temporal.worker_stopped",
      error: err,
    });
  });

  log.info("Temporal worker registered", {
    event: "temporal.worker_started",
    task_queue: taskQueue,
    namespace,
    address,
  });
  return worker;
}
