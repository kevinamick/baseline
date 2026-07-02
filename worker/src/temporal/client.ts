// Temporal Client seam for the worker's pgmq dispatcher. pg_cron can't call Temporal, so a
// scheduled eval run is enqueued onto pgmq and the worker's poll loop starts the durable
// `runEvalWorkflow` through this client, then acks the message (worker.ts `dispatchEvalRun`).
// Cached like the app's `src/lib/temporal/client.ts`, built from the shared connection seam +
// encryption codec so it uses the same task queue, namespace, TLS, and payload codec as the
// Worker. `@temporalio/client` connects over pure gRPC-js (no native core-bridge addon), so it
// is a cheap always-available client to hold alongside the NativeConnection the Worker uses.

import { Client, Connection } from "@temporalio/client";
import { getDataConverter } from "./codec.js";
import { getTemporalEnv } from "./connection.js";

let cached: Client | undefined;

export async function getTemporalClient(): Promise<Client> {
  if (cached) return cached;
  const { address, namespace, tls } = getTemporalEnv();
  const connection = await Connection.connect({ address, tls });
  cached = new Client({ connection, namespace, dataConverter: getDataConverter() });
  return cached;
}
