import { describe, it, expect, afterEach } from "vitest";
import { getTemporalEnv, OPTIMIZATION_TASK_QUEUE, OPTIMIZATION_RETRY_NOW_SIGNAL } from "../connection";

const ENV_KEYS = ["TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_TLS_CERT", "TEMPORAL_TLS_KEY"] as const;
const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("getTemporalEnv", () => {
  it("defaults to localhost/default namespace with no TLS when unset", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const env = getTemporalEnv();
    expect(env).toEqual({
      address: "localhost:7233",
      namespace: "default",
      tls: undefined,
      taskQueue: OPTIMIZATION_TASK_QUEUE,
    });
  });

  it("reads address and namespace from env vars", () => {
    process.env.TEMPORAL_ADDRESS = "cloud.temporal.io:7233";
    process.env.TEMPORAL_NAMESPACE = "baseline-prod";
    delete process.env.TEMPORAL_TLS_CERT;
    delete process.env.TEMPORAL_TLS_KEY;
    const env = getTemporalEnv();
    expect(env.address).toBe("cloud.temporal.io:7233");
    expect(env.namespace).toBe("baseline-prod");
    expect(env.tls).toBeUndefined();
  });

  it("builds an mTLS cert pair from base64 cert+key when both are present", () => {
    process.env.TEMPORAL_TLS_CERT = Buffer.from("cert-bytes").toString("base64");
    process.env.TEMPORAL_TLS_KEY = Buffer.from("key-bytes").toString("base64");
    const env = getTemporalEnv();
    expect(env.tls).toBeDefined();
    expect(env.tls!.clientCertPair.crt.toString()).toBe("cert-bytes");
    expect(env.tls!.clientCertPair.key.toString()).toBe("key-bytes");
  });

  it("stays plaintext when only the cert is present (key missing)", () => {
    process.env.TEMPORAL_TLS_CERT = Buffer.from("cert-bytes").toString("base64");
    delete process.env.TEMPORAL_TLS_KEY;
    expect(getTemporalEnv().tls).toBeUndefined();
  });

  it("stays plaintext when only the key is present (cert missing)", () => {
    delete process.env.TEMPORAL_TLS_CERT;
    process.env.TEMPORAL_TLS_KEY = Buffer.from("key-bytes").toString("base64");
    expect(getTemporalEnv().tls).toBeUndefined();
  });

  it("always carries the shared task queue", () => {
    expect(getTemporalEnv().taskQueue).toBe("baseline-optimizations");
  });
});

describe("constants", () => {
  it("exposes the task queue and retry signal names", () => {
    expect(OPTIMIZATION_TASK_QUEUE).toBe("baseline-optimizations");
    expect(OPTIMIZATION_RETRY_NOW_SIGNAL).toBe("retryNow");
  });
});
