import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";

// server.ts has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

// Capture OTel emits + flushes without a real LoggerProvider. Keep the real
// SeverityNumber enum so the module's mapping is tested against the actual values.
const mockEmit = vi.fn();
const mockForceFlush = vi.fn().mockResolvedValue(undefined);
vi.mock("@opentelemetry/api-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/api-logs")>();
  return {
    ...actual,
    logs: {
      getLogger: () => ({ emit: mockEmit }),
      getLoggerProvider: () => ({ forceFlush: mockForceFlush }),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mockForceFlush.mockResolvedValue(undefined); // re-arm: individual tests override it
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importLog() {
  const { log } = await import("../server");
  return log;
}

// --- severity mapping ---

describe("severity mapping", () => {
  it("maps info/warn/error to the OTel SeverityNumber and severityText", async () => {
    const log = await importLog();
    await log.info("info message");
    await log.warn("warn message");
    await log.error("error message");

    expect(mockEmit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        body: "info message",
      })
    );
    expect(mockEmit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        severityNumber: SeverityNumber.WARN,
        severityText: "WARN",
        body: "warn message",
      })
    );
    expect(mockEmit).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        body: "error message",
      })
    );
  });

  it("flushes the provider after emitting (serverless contract)", async () => {
    const log = await importLog();
    await log.error("boom", { event: "test.failed" });
    expect(mockForceFlush).toHaveBeenCalled();
  });
});

// --- flush latency bounds ---

describe("flush latency bounds", () => {
  it("does not hold info logs hostage to the flush (fire-and-forget)", async () => {
    // A flush that never settles — if log.info awaited it, this test would time out.
    mockForceFlush.mockReturnValue(new Promise<void>(() => {}));
    const log = await importLog();
    await expect(log.info("hello", { event: "x" })).resolves.toBeUndefined();
    expect(mockForceFlush).toHaveBeenCalled(); // the flush is still kicked off
  });

  it("caps the awaited warn/error flush when PostHog hangs", async () => {
    vi.useFakeTimers();
    try {
      mockForceFlush.mockReturnValue(new Promise<void>(() => {}));
      const log = await importLog();
      const pending = log.error("boom", { event: "x" });
      await vi.advanceTimersByTimeAsync(1000); // FLUSH_WAIT_MS
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- console mirroring ---

describe("console mirroring", () => {
  it("mirrors info to console.log, warn to console.warn, error to console.error", async () => {
    const log = await importLog();
    const attrs = { event: "test.event", run_id: "run_1" };
    await log.info("info message", attrs);
    await log.warn("warn message", attrs);
    await log.error("error message", attrs);

    expect(console.log).toHaveBeenCalledWith("info message", attrs);
    expect(console.warn).toHaveBeenCalledWith("warn message", attrs);
    expect(console.error).toHaveBeenCalledWith("error message", attrs);
  });

  it("mirrors the bare message when no attributes are given", async () => {
    const log = await importLog();
    await log.info("just a message");
    expect(console.log).toHaveBeenCalledWith("just a message");
  });

  it("mirrors through the console function installed at call time (late binding)", async () => {
    const log = await importLog(); // module already loaded with the original console.error
    const patched = vi.fn();
    const previous = console.error;
    console.error = patched; // e.g. a test spy or other instrumentation patching after import
    try {
      await log.error("after patch");
    } finally {
      console.error = previous;
    }
    expect(patched).toHaveBeenCalledWith("after patch");
  });
});

// --- graceful degradation without the key ---

describe("without NEXT_PUBLIC_POSTHOG_KEY", () => {
  it("skips the PostHog emit but still mirrors to console", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const log = await importLog();
    await log.error("db insert failed", { event: "thing.create_failed" });

    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockForceFlush).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("db insert failed", {
      event: "thing.create_failed",
    });
  });
});

// --- error-attribute flattening ---

describe("error attribute flattening", () => {
  it("flattens an Error into error_message + error_stack", async () => {
    const log = await importLog();
    const err = new Error("kaboom");
    await log.error("operation failed", { event: "op.failed", error: err });

    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.error_message).toBe("kaboom");
    expect(attrs.error_stack).toContain("kaboom");
    expect(attrs.event).toBe("op.failed");
  });

  it("flattens a Supabase-style plain error object", async () => {
    const log = await importLog();
    await log.error("insert failed", {
      event: "row.insert_failed",
      error: { message: "duplicate key", code: "23505" },
    });

    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.error_message).toBe("duplicate key");
    expect(attrs.error_detail).toContain("23505");
  });

  it("whitelists error_detail fields — Postgres `detail` row values never ship (PII)", async () => {
    const log = await importLog();
    await log.error("insert failed", {
      event: "row.insert_failed",
      error: {
        message: "duplicate key value violates unique constraint",
        code: "23505",
        hint: "is the invite already sent?",
        name: "PostgrestError",
        detail: "Key (org_id, email)=(org_1, person@example.com) already exists.",
      },
    });

    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.error_message).toBe("duplicate key value violates unique constraint");
    expect(attrs.error_detail).toContain("23505");
    expect(attrs.error_detail).toContain("is the invite already sent?");
    expect(attrs.error_detail).toContain("PostgrestError");
    // The GDPR-relevant part: row values from Postgres `detail` must not be forwarded.
    expect(JSON.stringify(attrs)).not.toContain("person@example.com");
  });

  it("stringifies a non-object error and drops null/undefined attributes", async () => {
    const log = await importLog();
    await log.error("failed", { event: "x.failed", error: "plain string", gone: null });

    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.error_message).toBe("plain string");
    expect("gone" in attrs).toBe(false);
  });

  it("serializes non-scalar attribute values", async () => {
    const log = await importLog();
    await log.info("structured", { event: "x.y", nested: { a: 1 }, flag: true, n: 2 });

    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.nested).toBe('{"a":1}');
    expect(attrs.flag).toBe(true);
    expect(attrs.n).toBe(2);
  });
});

// --- never throws ---

describe("resilience", () => {
  it("resolves even when the OTel emit throws", async () => {
    mockEmit.mockImplementation(() => {
      throw new Error("otel exploded");
    });
    const log = await importLog();
    await expect(log.error("still fine", { event: "x" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("still fine", { event: "x" });
  });

  it("resolves even when the flush rejects (PostHog down)", async () => {
    mockForceFlush.mockRejectedValue(new Error("network down"));
    const log = await importLog();
    await expect(log.info("still fine")).resolves.toBeUndefined();
  });

  it("never throws on circular attribute values", async () => {
    const log = await importLog();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(log.info("circular", { event: "x", data: circular })).resolves.toBeUndefined();
  });

  it("keeps the record when an attribute value is unserializable", async () => {
    const log = await importLog();
    // Null-prototype + circular: JSON.stringify throws (circular) AND String() throws
    // (no Symbol.toPrimitive / toString) — the record must survive with a placeholder.
    const evil = Object.create(null) as Record<string, unknown>;
    evil.self = evil;
    await expect(log.info("exotic", { event: "x", data: evil })).resolves.toBeUndefined();

    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.data).toBe("[unserializable]");
    expect(attrs.event).toBe("x");
  });
});

// worker/src/log-attributes.ts is bundled into the Next.js app via the import in
// src/lib/logging/server.ts (same cross-package pattern as worker/src/prompt-refs.ts), so
// it must stay import-free: a worker-local import (NodeNext ".js" specifier, worker-only
// deps, …) would compile fine for the worker and only break the Next build — or silently
// pull worker code into the app bundle. Fail here, closest to the cause.
describe("worker/src/log-attributes.ts cross-package invariant", () => {
  it("contains no import or require statements", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../../worker/src/log-attributes.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    // Re-export form (`export { x } from "./y"`) is an import too.
    expect(source).not.toMatch(/^\s*export\s*[{*][^;]*?from\s*["']/m);
  });
});
