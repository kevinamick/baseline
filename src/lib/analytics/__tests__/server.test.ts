import { describe, it, expect, vi, beforeEach } from "vitest";

const captureLog = vi.fn();
const capture = vi.fn();
const flush = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => ({ capture, captureLog, flush })),
}));

vi.mock("server-only", () => ({}));

beforeEach(() => {
  capture.mockClear();
  captureLog.mockClear();
  flush.mockClear();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("analytics/server log()", () => {
  it("no-ops when NEXT_PUBLIC_POSTHOG_KEY is unset", async () => {
    const { log } = await import("../server");
    await log("info", "test message");
    expect(captureLog).not.toHaveBeenCalled();
  });

  it("calls captureLog with correct level and message", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const { log } = await import("../server");
    await log("error", "something went wrong", { detail: "db timeout" }, { userId: "u_1" });
    expect(captureLog).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "u_1",
        level: "error",
        message: "something went wrong",
        properties: expect.objectContaining({ detail: "db timeout" }),
      })
    );
    expect(flush).toHaveBeenCalled();
  });

  it("falls back to anonymous distinctId when no identity provided", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const { log } = await import("../server");
    await log("debug", "startup");
    expect(captureLog).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: "anonymous" })
    );
  });
});
