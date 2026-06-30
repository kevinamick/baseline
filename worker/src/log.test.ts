import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";

// Swap the OTLP exporter for an in-memory capture so we can assert on the records the
// provider actually exports, without any network.
const captured: { records: ReadableLogRecord[]; config: unknown } = {
  records: [],
  config: null,
};
vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {
    constructor(config: unknown) {
      captured.config = config;
    }
    export(records: ReadableLogRecord[], cb: (result: { code: number }) => void) {
      captured.records.push(...records);
      cb({ code: 0 }); // ExportResultCode.SUCCESS
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  captured.records = [];
  captured.config = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importWithKey() {
  vi.stubEnv("POSTHOG_KEY", "phc_test");
  vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
  const mod = await import("./log.js");
  mod.initLogging();
  return mod;
}

// --- exporter wiring ---

describe("initLogging", () => {
  it("points the OTLP exporter at <host>/i/v1/logs with bearer auth and a bounded timeout", async () => {
    await importWithKey();
    expect(captured.config).toMatchObject({
      url: "https://us.i.posthog.com/i/v1/logs",
      headers: {
        Authorization: "Bearer phc_test",
        "Content-Type": "application/json",
      },
      timeoutMillis: 2000, // never inherit the otlp-exporter-base 10s default
    });
  });
});

// --- severity mapping + structured attributes (assert on exported records) ---

describe("emitted records", () => {
  it("maps levels to OTel severity and flattens attributes", async () => {
    const { log, shutdownLogging } = await importWithKey();
    log.info("worker started", { event: "worker.started", provider: "anthropic" });
    log.warn("something odd", { event: "x.odd" });
    log.error("run failed", { event: "eval_run.failed", run_id: "run_1", error: new Error("kaboom") });
    await shutdownLogging(); // drains the batch processor into the exporter

    expect(captured.records).toHaveLength(3);
    const [info, warn, error] = captured.records;
    expect(info.severityNumber).toBe(SeverityNumber.INFO);
    expect(info.severityText).toBe("INFO");
    expect(info.body).toBe("worker started");
    expect(info.attributes).toMatchObject({ event: "worker.started", provider: "anthropic" });

    expect(warn.severityNumber).toBe(SeverityNumber.WARN);

    expect(error.severityNumber).toBe(SeverityNumber.ERROR);
    expect(error.attributes.run_id).toBe("run_1");
    expect(error.attributes.error_message).toBe("kaboom");
    expect(String(error.attributes.error_stack)).toContain("kaboom");
  });

  it("carries the worker resource identity", async () => {
    const { log, shutdownLogging } = await importWithKey();
    log.info("hello");
    await shutdownLogging();
    expect(captured.records[0].resource.attributes["service.name"]).toBe("baseline-worker");
  });

  it("flattens a Supabase-style plain error object", async () => {
    const { log, shutdownLogging } = await importWithKey();
    log.error("reaper error", { event: "eval_run.reap_failed", error: { message: "db error", code: "42501" } });
    await shutdownLogging();
    expect(captured.records[0].attributes.error_message).toBe("db error");
    expect(String(captured.records[0].attributes.error_detail)).toContain("42501");
  });

  it("whitelists error_detail fields — Postgres `detail` row values never ship (PII)", async () => {
    const { log, shutdownLogging } = await importWithKey();
    log.error("insert failed", {
      event: "row.insert_failed",
      error: {
        message: "duplicate key value violates unique constraint",
        code: "23505",
        hint: "is the invite already sent?",
        name: "PostgrestError",
        detail: "Key (org_id, email)=(org_1, person@example.com) already exists.",
      },
    });
    await shutdownLogging();

    const attrs = captured.records[0].attributes;
    expect(attrs.error_message).toBe("duplicate key value violates unique constraint");
    expect(String(attrs.error_detail)).toContain("23505");
    expect(String(attrs.error_detail)).toContain("is the invite already sent?");
    expect(String(attrs.error_detail)).toContain("PostgrestError");
    // The GDPR-relevant part: row values from Postgres `detail` must not be forwarded.
    expect(JSON.stringify(attrs)).not.toContain("person@example.com");
  });
});

// --- console mirroring ---

describe("console mirroring", () => {
  it("mirrors info/warn/error to console.log/warn/error with the same args", async () => {
    const { log } = await importWithKey();
    const attrs = { event: "x.y", run_id: "run_1" };
    log.info("info message", attrs);
    log.warn("warn message", attrs);
    log.error("error message", attrs);

    expect(console.log).toHaveBeenCalledWith("info message", attrs);
    expect(console.warn).toHaveBeenCalledWith("warn message", attrs);
    expect(console.error).toHaveBeenCalledWith("error message", attrs);
  });

  it("mirrors the bare message when no attributes are given", async () => {
    const { log } = await importWithKey();
    log.info("just a message");
    expect(console.log).toHaveBeenCalledWith("just a message");
  });

  // The mirror resolves console.* at call time, so a console function swapped in
  // after this module is imported (a test spy, or any other instrumentation) still wins.
  it("mirrors through the console function installed at call time (late binding)", async () => {
    const { log } = await importWithKey(); // module already loaded with the original console.error
    const patched = vi.fn();
    const previous = console.error;
    console.error = patched;
    try {
      log.error("after patch");
    } finally {
      console.error = previous;
    }
    expect(patched).toHaveBeenCalledWith("after patch");
  });
});

// --- ambient run-context correlation ---

describe("run-context stamping", () => {
  it("stamps run_id and org_id from the ambient context onto records inside the scope", async () => {
    const { log, shutdownLogging } = await importWithKey();
    const { runWithLogContext, setLogContext } = await import("./log-context.js");

    await runWithLogContext({ run_id: "run_42" }, async () => {
      log.info("processing", { event: "eval_run.dequeued" });
      setLogContext({ org_id: "org_7" }); // patched in after the rubric loads
      log.warn("deep call site", { event: "optimization_run.reflect_model_fallback" });
    });
    await shutdownLogging();

    const [first, second] = captured.records;
    expect(first.attributes).toMatchObject({ event: "eval_run.dequeued", run_id: "run_42" });
    expect(second.attributes).toMatchObject({
      event: "optimization_run.reflect_model_fallback",
      run_id: "run_42",
      org_id: "org_7",
    });
  });

  it("lets an explicit run_id/org_id on the call win over the ambient context", async () => {
    const { log, shutdownLogging } = await importWithKey();
    const { runWithLogContext } = await import("./log-context.js");

    await runWithLogContext({ run_id: "ambient", org_id: "ambient_org" }, async () => {
      log.error("override", { event: "x", run_id: "explicit", org_id: "explicit_org" });
    });
    await shutdownLogging();

    expect(captured.records[0].attributes).toMatchObject({
      run_id: "explicit",
      org_id: "explicit_org",
    });
  });

  it("emits no run_id/org_id outside any run scope", async () => {
    const { log, shutdownLogging } = await importWithKey();
    log.info("no scope", { event: "worker.started" });
    await shutdownLogging();

    const attrs = captured.records[0].attributes;
    expect(attrs.run_id).toBeUndefined();
    expect(attrs.org_id).toBeUndefined();
  });

  it("leaves the console mirror free of the ambient context (correlation is OTel-only)", async () => {
    const { log } = await importWithKey();
    const { runWithLogContext } = await import("./log-context.js");

    const attrs = { event: "eval_run.dequeued" };
    await runWithLogContext({ run_id: "run_99", org_id: "org_1" }, async () => {
      log.info("mirror", attrs);
    });

    // The mirror receives exactly the caller's args, byte-for-byte — no injected run_id.
    expect(console.log).toHaveBeenCalledWith("mirror", attrs);
  });
});

// --- graceful degradation without the key ---

describe("without POSTHOG_KEY", () => {
  it("creates no provider and exports nothing, but still mirrors to console", async () => {
    vi.stubEnv("POSTHOG_KEY", "");
    const { log, initLogging, shutdownLogging } = await import("./log.js");
    initLogging();
    log.error("db insert failed", { event: "thing.create_failed" });
    await shutdownLogging();

    expect(captured.config).toBeNull(); // exporter never constructed
    expect(captured.records).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith("db insert failed", {
      event: "thing.create_failed",
    });
  });
});

// --- never throws ---

describe("resilience", () => {
  it("does not throw on circular attribute values", async () => {
    const { log } = await importWithKey();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info("circular", { event: "x", data: circular })).not.toThrow();
  });

  it("keeps the record when an attribute value is unserializable", async () => {
    const { log, shutdownLogging } = await importWithKey();
    // Null-prototype + circular: JSON.stringify throws (circular) AND String() throws
    // (no Symbol.toPrimitive / toString) — the record must survive with a placeholder.
    const evil = Object.create(null) as Record<string, unknown>;
    evil.self = evil;
    expect(() => log.info("exotic", { event: "x", data: evil })).not.toThrow();
    await shutdownLogging();

    expect(captured.records).toHaveLength(1);
    expect(captured.records[0].attributes.data).toBe("[unserializable]");
    expect(captured.records[0].attributes.event).toBe("x");
  });

  it("does not throw when logging before initLogging", async () => {
    const { log } = await import("./log.js");
    expect(() => log.error("early", { event: "x" })).not.toThrow();
    expect(console.error).toHaveBeenCalledWith("early", { event: "x" });
  });

  it("shutdownLogging never rejects, even called twice", async () => {
    const { shutdownLogging } = await importWithKey();
    await expect(shutdownLogging()).resolves.toBeUndefined();
    await expect(shutdownLogging()).resolves.toBeUndefined();
  });
});
