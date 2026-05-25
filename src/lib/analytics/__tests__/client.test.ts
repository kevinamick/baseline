import { describe, it, expect, vi, beforeEach } from "vitest";

const capture = vi.fn();
const identify = vi.fn();
const reset = vi.fn();

vi.mock("posthog-js", () => ({
  default: { capture, identify, reset },
}));

beforeEach(() => {
  capture.mockClear();
  identify.mockClear();
  reset.mockClear();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("analytics/client track()", () => {
  it("no-ops when NEXT_PUBLIC_POSTHOG_KEY is unset", async () => {
    const { track } = await import("../client");
    track({ name: "auth.signup_started" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("no-ops in a Node environment even with the key set (no window)", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const { track } = await import("../client");
    track({ name: "auth.signup_started" });
    expect(capture).not.toHaveBeenCalled();
  });
});
