// The single seam that owns how we reach Temporal. Both the Client (server-action side)
// and the Worker read connection details from here, and here only — so moving between
// local dev, Temporal Cloud, and a future self-hosted cluster is an env change, not a
// code change (ADR-0006). This is the Next-app copy; `worker/src/temporal/connection.ts`
// is the worker copy and must stay in sync.

// The worker's single Temporal task queue. Despite the historical name it now carries all
// workflow types (optimizations and flagged Eval Runs); consolidating the naming is part of
// the shared-seam extraction (#93).
export const OPTIMIZATION_TASK_QUEUE = "baseline-optimizations";

// Signal name for resuming a paused Optimization Run immediately (#102). Part of the
// client↔worker contract like the task queue: the workflow registers a handler under this
// name and the Next app's retry action signals it by name.
export const OPTIMIZATION_RETRY_NOW_SIGNAL = "retryNow";

// mTLS client cert pair, shaped identically for the worker's NativeConnection and the
// client's Connection. Absent locally (the dev server is plaintext); present for Cloud.
export interface TemporalTls {
  clientCertPair: { crt: Buffer; key: Buffer };
}

export interface TemporalEnv {
  address: string;
  namespace: string;
  tls: TemporalTls | undefined;
  taskQueue: string;
}

export function getTemporalEnv(): TemporalEnv {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const crt = process.env.TEMPORAL_TLS_CERT;
  const key = process.env.TEMPORAL_TLS_KEY;
  // Presence of a cert pair flips mTLS on (Cloud); absence means plaintext (local dev).
  const tls: TemporalTls | undefined =
    crt && key
      ? { clientCertPair: { crt: Buffer.from(crt, "base64"), key: Buffer.from(key, "base64") } }
      : undefined;
  return { address, namespace, tls, taskQueue: OPTIMIZATION_TASK_QUEUE };
}

// Eval Runs on Temporal (#123): opt-in flag for the create path. Off (the default) the
// create path enqueues onto pgmq exactly as before; on, it starts the durable Eval Run
// workflow instead (no pgmq involvement). Mirrors the worker's TEMPORAL_ENABLED opt-in
// style; both paths coexist until the cutover (#126) retires the pgmq loop.
export function evalRunsOnTemporal(): boolean {
  return process.env.EVAL_RUNS_ON_TEMPORAL === "true";
}
