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

    track({ name: "provider_key.saved", props: { team_id: "org-1", provider: "openai" } });
    identifyFn("user-1");
    resetFn();

    expect(capture).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("no-ops when the PostHog key is unset even if consent was given", async () => {
    mockAnalyticsAllowed.mockReturnValue(true);
    const { track } = await import("../client");
    track({ name: "provider_key.saved", props: { team_id: "org-1", provider: "openai" } });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures a track() event once the key is set and consent is given", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(true);
    const { track } = await import("../client");

    track({ name: "provider_key.removed", props: { team_id: "org-1", provider: "openai" } });

    expect(capture).toHaveBeenCalledWith("provider_key.removed", { team_id: "org-1", provider: "openai" });
  });

  it("defaults to an empty props object when the event carries none", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    mockAnalyticsAllowed.mockReturnValue(true);
    const { track } = await import("../client");

    track({ name: "rubric.create_dialog_opened" });

    expect(capture).toHaveBeenCalledWith("rubric.create_dialog_opened", {});
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
