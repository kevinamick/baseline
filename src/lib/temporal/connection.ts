// The single seam that owns how we reach Temporal. Both the Client (server-action side)
// and the Worker read connection details from here, and here only — so moving between
// local dev, Temporal Cloud, and a future self-hosted cluster is an env change, not a
// code change (ADR-0006). This is the Next-app copy; `worker/src/temporal/connection.ts`
// is the worker copy and must stay in sync.

export const OPTIMIZATION_TASK_QUEUE = "baseline-optimizations";

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
