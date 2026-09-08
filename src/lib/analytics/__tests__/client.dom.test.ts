// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const capture = vi.fn();
const identify = vi.fn();
const reset = vi.fn();
const mockAnalyticsAllowed = vi.fn();

vi.mock("posthog-js", () => ({
  default: { capture, identify, reset },
}));
vi.mock("@/lib/consent/cookie", () => ({
  analyticsAllowed: mockAnalyticsAllowed,
}));

beforeEach(() => {
  capture.mockClear();
  identify.mockClear();
  reset.mockClear();
  mockAnalyticsAllowed.mockReset();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("analytics/client in a browser environment", () => {
  it("no-ops track/identify/reset when consent has not been given", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(false);
    const { track, identify: identifyFn, reset: resetFn } = await import("../client");

    track({ name: "billing.checkout_success" });
    identifyFn("user-1");
    resetFn();

    expect(capture).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("no-ops when the PostHog key is unset even if consent was given", async () => {
    mockAnalyticsAllowed.mockReturnValue(true);
    const { track } = await import("../client");
    track({ name: "billing.checkout_success" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures a track() event once the key is set and consent is given", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(true);
    const { track } = await import("../client");

    track({ name: "billing.portal_opened", props: { team_id: "org-1" } });

    expect(capture).toHaveBeenCalledWith("billing.portal_opened", { team_id: "org-1" });
  });

  it("defaults to an empty props object when the event carries none", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(true);
    const { track } = await import("../client");

    track({ name: "billing.checkout_success" });

    expect(capture).toHaveBeenCalledWith("billing.checkout_success", {});
  });

  it("identifies a user with traits when enabled", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(true);
    const { identify: identifyFn } = await import("../client");

    identifyFn("user-1", { plan: "builder" });

    expect(identify).toHaveBeenCalledWith("user-1", { plan: "builder" });
  });

  it("resets the client when enabled", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(true);
    const { reset: resetFn } = await import("../client");

    resetFn();

    expect(reset).toHaveBeenCalledOnce();
  });
});
