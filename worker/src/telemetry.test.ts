// Pins the worker exception-capture wrapper (telemetry.ts): it must delegate to
// posthog-node's captureException with the "worker" distinct id and pass the context
// through as additional properties, and must no-op without POSTHOG_KEY. The exported
// signature is load-bearing — worker.ts (and PRs #161/#162) call it synchronously.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCaptureException = vi.fn();
const mockCapture = vi.fn();
const mockFlush = vi.fn(() => Promise.resolve());
const mockCtor = vi.fn();

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      mockCtor(...args);
    }
    captureException = mockCaptureException;
    capture = mockCapture;
    flush = mockFlush;
  },
}));

vi.mock("./log.js", () => ({ initLogging: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules(); // telemetry.ts caches the client per module instance
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importTelemetry() {
  return import("./telemetry.js");
}

describe("captureException", () => {
  it("no-ops without POSTHOG_KEY (graceful degradation)", async () => {
    vi.stubEnv("POSTHOG_KEY", "");
    const { captureException } = await importTelemetry();

    captureException(new Error("boom"));

    expect(mockCtor).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("delegates to posthog-node with the worker distinct id and context properties", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const { captureException } = await importTelemetry();

    const err = new Error("boom");
    captureException(err, { run_id: "r1" });

    expect(mockCaptureException).toHaveBeenCalledWith(err, "worker", { run_id: "r1" });
    expect(mockFlush).toHaveBeenCalled();
  });

  it("passes no properties when context is omitted", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const { captureException } = await importTelemetry();

    const err = new Error("boom");
    captureException(err);

    expect(mockCaptureException).toHaveBeenCalledWith(err, "worker", undefined);
  });

  it("never throws, even when the client does", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockCaptureException.mockImplementation(() => {
      throw new Error("posthog down");
    });
    const { captureException } = await importTelemetry();

    expect(() => captureException(new Error("boom"))).not.toThrow();
  });
});
