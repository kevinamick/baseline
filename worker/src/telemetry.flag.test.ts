import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The default matrix of isKillSwitchFlagEnabled (telemetry.ts, #84):
//   - PostHog NOT configured (no POSTHOG_KEY): ENABLED — the flag is an operational kill
//     switch, so environments with no control plane keep the shipped behavior.
//   - PostHog configured: the flag decides; an evaluation error or an undefined result fails
//     to DISABLED, and the check never throws.
// The module caches its PostHog client in a singleton, so each test re-imports telemetry.ts
// fresh (vi.resetModules) after stubbing POSTHOG_KEY.

const { mockIsFeatureEnabled } = vi.hoisted(() => ({ mockIsFeatureEnabled: vi.fn() }));

vi.mock("posthog-node", () => ({
  PostHog: class {
    isFeatureEnabled = mockIsFeatureEnabled;
  },
}));

// telemetry.ts imports initLogging at module load; keep this unit test free of the OTel wiring.
vi.mock("./log.js", () => ({ initLogging: vi.fn() }));

async function loadIsKillSwitchFlagEnabled() {
  vi.resetModules();
  const mod = await import("./telemetry.js");
  return mod.isKillSwitchFlagEnabled;
}

beforeEach(() => {
  mockIsFeatureEnabled.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isKillSwitchFlagEnabled", () => {
  it("defaults ENABLED when PostHog is not configured (no POSTHOG_KEY)", async () => {
    vi.stubEnv("POSTHOG_KEY", "");
    const isKillSwitchFlagEnabled = await loadIsKillSwitchFlagEnabled();

    await expect(isKillSwitchFlagEnabled("system-aware-merge", "org_1")).resolves.toBe(true);
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it("returns true when PostHog is configured and the flag is on, evaluated with the given distinctId", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockResolvedValue(true);
    const isKillSwitchFlagEnabled = await loadIsKillSwitchFlagEnabled();

    await expect(isKillSwitchFlagEnabled("system-aware-merge", "org_1")).resolves.toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith("system-aware-merge", "org_1");
  });

  it("returns false when PostHog is configured and the flag is off", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockResolvedValue(false);
    const isKillSwitchFlagEnabled = await loadIsKillSwitchFlagEnabled();

    await expect(isKillSwitchFlagEnabled("system-aware-merge", "org_1")).resolves.toBe(false);
  });

  it("fails to DISABLED on an undefined evaluation result (flag unreadable)", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockResolvedValue(undefined);
    const isKillSwitchFlagEnabled = await loadIsKillSwitchFlagEnabled();

    await expect(isKillSwitchFlagEnabled("system-aware-merge", "org_1")).resolves.toBe(false);
  });

  it("fails to DISABLED (never throws) when the evaluation rejects", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    mockIsFeatureEnabled.mockRejectedValue(new Error("posthog down"));
    const isKillSwitchFlagEnabled = await loadIsKillSwitchFlagEnabled();

    await expect(isKillSwitchFlagEnabled("system-aware-merge", "org_1")).resolves.toBe(false);
  });
});
