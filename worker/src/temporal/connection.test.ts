import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTemporalEnv, OPTIMIZATION_TASK_QUEUE } from "./connection.js";

// getTemporalEnv (ADR-0006): the single seam resolving how the worker reaches Temporal. Local
// dev has no TLS cert pair configured (plaintext); Temporal Cloud sets TEMPORAL_TLS_CERT/KEY
// (mTLS). Exercise both branches plus the address/namespace env overrides and defaults.
//
// vi.stubEnv can't express "unset" (it always sets a string, and "" is not nullish so the env's
// own `?? default` fallback wouldn't kick in) — save/restore process.env directly instead.
const VARS = [
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TLS_CERT",
  "TEMPORAL_TLS_KEY",
] as const;

describe("getTemporalEnv", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      original[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (original[v] === undefined) delete process.env[v];
      else process.env[v] = original[v];
    }
  });

  it("defaults to localhost:7233 / default namespace / no TLS (local dev)", () => {
    const env = getTemporalEnv();
    expect(env.address).toBe("localhost:7233");
    expect(env.namespace).toBe("default");
    expect(env.tls).toBeUndefined();
    expect(env.taskQueue).toBe(OPTIMIZATION_TASK_QUEUE);
  });

  it("honors TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE overrides", () => {
    process.env.TEMPORAL_ADDRESS = "temporal.internal:7233";
    process.env.TEMPORAL_NAMESPACE = "baseline-prod";
    const env = getTemporalEnv();
    expect(env.address).toBe("temporal.internal:7233");
    expect(env.namespace).toBe("baseline-prod");
  });

  it("builds the mTLS client cert pair from base64 env vars when both are present (Cloud)", () => {
    process.env.TEMPORAL_TLS_CERT = Buffer.from("fake-cert-pem").toString("base64");
    process.env.TEMPORAL_TLS_KEY = Buffer.from("fake-key-pem").toString("base64");
    const env = getTemporalEnv();
    expect(env.tls).toBeDefined();
    expect(env.tls?.clientCertPair.crt.toString()).toBe("fake-cert-pem");
    expect(env.tls?.clientCertPair.key.toString()).toBe("fake-key-pem");
  });

  it("stays plaintext (tls undefined) when only the cert is present", () => {
    process.env.TEMPORAL_TLS_CERT = Buffer.from("cert-only").toString("base64");
    expect(getTemporalEnv().tls).toBeUndefined();
  });

  it("stays plaintext (tls undefined) when only the key is present", () => {
    process.env.TEMPORAL_TLS_KEY = Buffer.from("key-only").toString("base64");
    expect(getTemporalEnv().tls).toBeUndefined();
  });

  it("always carries the single worker task queue", () => {
    expect(getTemporalEnv().taskQueue).toBe("baseline-optimizations");
  });
});
