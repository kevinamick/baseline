import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// The full failure matrix of isSignupGated (signup-gate.ts, ADR-0017 #425):
//   - PostHog NOT configured (no POSTHOG_KEY — dev/CI/e2e default): ungated (false).
//     There's no control plane to read, so the pre-launch-gate behavior stands.
//   - PostHog configured: the flag decides.
//   - An undefined evaluation result, a rejection, or a response slower than the
//     timeout all fail to GATED (true) — the opposite failure direction from the
//     worker's kill-switch helper (isKillSwitchFlagEnabled), deliberately: an
//     outage must never silently open registration.
// The module caches its PostHog client in a module-level singleton, so each test
// re-imports signup-gate.ts fresh (vi.resetModules) after stubbing POSTHOG_KEY.

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    isFeatureEnabled = mockIsFeatureEnabled;
  },
}));

async function loadIsSignupGated() {
  vi.resetModules();
  const mod = await import("../signup-gate");
  return mod.isSignupGated;
}

beforeEach(() => {
  mockIsFeatureEnabled.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("isSignupGated", () => {
  it("defaults ungated when PostHog is not configured (no POSTHOG_KEY)", async () => {
    vi.stubEnv("POSTHOG_KEY", "");
    const isSignupGated = await loadIsSignupGated();

    await expect(isSignupGated()).resolves.toBe(false);
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it("gates when PostHog is configured and the flag is on, evaluated with an anonymous distinctId", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockResolvedValue(true);
    const isSignupGated = await loadIsSignupGated();

    await expect(isSignupGated()).resolves.toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      "signup-access-code-gate",
      "signup-gate",
      { sendFeatureFlagEvents: false }
    );
  });

  it("stays ungated when PostHog is configured and the flag is off", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockResolvedValue(false);
    const isSignupGated = await loadIsSignupGated();

    await expect(isSignupGated()).resolves.toBe(false);
  });

  it("fails to GATED on an undefined evaluation result (flag unreadable)", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockResolvedValue(undefined);
    const isSignupGated = await loadIsSignupGated();

    await expect(isSignupGated()).resolves.toBe(true);
  });

  it("fails to GATED (never throws) when the evaluation rejects", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockRejectedValue(new Error("posthog down"));
    const isSignupGated = await loadIsSignupGated();

    await expect(isSignupGated()).resolves.toBe(true);
  });

  it("fails to GATED when evaluation is slower than the timeout", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    vi.useFakeTimers();
    // Never resolves within the test — the race must fall through the timeout.
    mockIsFeatureEnabled.mockImplementation(() => new Promise(() => {}));
    const isSignupGated = await loadIsSignupGated();

    const result = isSignupGated();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toBe(true);
  });
});
