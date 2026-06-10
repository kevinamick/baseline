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

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  captured.config = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function build() {
  const { posthogLogRecordProcessor } = await import("../otel");
  return posthogLogRecordProcessor();
}

describe("posthogLogRecordProcessor", () => {
  it("points the OTLP exporter at <host>/i/v1/logs with bearer auth and a bounded timeout", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    // Trailing slash exercises the host normalization.
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com/");
    const processor = await build();

    expect(processor).not.toBeNull();
    expect(captured.config).toMatchObject({
      url: "https://eu.i.posthog.com/i/v1/logs",
      headers: {
        Authorization: "Bearer phc_test",
        "Content-Type": "application/json",
      },
      timeoutMillis: 2000,
    });
  });

  it("defaults the host to https://us.i.posthog.com", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", undefined);
    await build();

    expect(captured.config).toMatchObject({ url: "https://us.i.posthog.com/i/v1/logs" });
  });

  it("returns null without NEXT_PUBLIC_POSTHOG_KEY (graceful degradation)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const processor = await build();

    expect(processor).toBeNull();
    expect(captured.config).toBeNull(); // exporter never constructed
  });
});
