// Pins the app-side exporter wiring (src/lib/logging/otel.ts) — mirrors the `initLogging`
// block of worker/src/log.test.ts. Every failure on this path is deliberately swallowed at
// runtime, so drift (wrong env var, wrong URL path, dropped auth header) would otherwise
// ship as silently-vanishing logs with green CI.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the exporter construction instead of opening sockets.
const captured: { config: unknown } = { config: null };
vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {
    constructor(config: unknown) {
      captured.config = config;
    }
    export(_records: unknown[], cb: (result: { code: number }) => void) {
      cb({ code: 0 });
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

// Spy on the global registration so tests don't pollute the process-wide
// (Symbol.for-keyed) logger-provider slot that other suites share.
const mockSetGlobalLoggerProvider = vi.fn();
vi.mock("@opentelemetry/api-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/api-logs")>();
  return {
    ...actual,
    logs: { ...actual.logs, setGlobalLoggerProvider: mockSetGlobalLoggerProvider },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  captured.config = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function register() {
  const { registerLogging } = await import("../otel");
  registerLogging();
}

describe("registerLogging", () => {
  it("points the OTLP exporter at <host>/i/v1/logs with bearer auth and a bounded timeout", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    // Trailing slash exercises the host normalization.
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com/");
    await register();

    expect(captured.config).toMatchObject({
      url: "https://eu.i.posthog.com/i/v1/logs",
      headers: {
        Authorization: "Bearer phc_test",
        "Content-Type": "application/json",
      },
      timeoutMillis: 2000,
    });
    expect(mockSetGlobalLoggerProvider).toHaveBeenCalledTimes(1);
  });

  it("defaults the host to https://us.i.posthog.com", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", undefined);
    await register();

    expect(captured.config).toMatchObject({ url: "https://us.i.posthog.com/i/v1/logs" });
  });

  it("no-ops without NEXT_PUBLIC_POSTHOG_KEY (graceful degradation)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    await register();

    expect(captured.config).toBeNull(); // exporter never constructed
    expect(mockSetGlobalLoggerProvider).not.toHaveBeenCalled();
  });
});
