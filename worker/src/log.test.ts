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
  it("points the OTLP exporter at <host>/i/v1/logs with bearer auth", async () => {
    await importWithKey();
    expect(captured.config).toMatchObject({
      url: "https://us.i.posthog.com/i/v1/logs",
      headers: {
        Authorization: "Bearer phc_test",
        "Content-Type": "application/json",
      },
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
