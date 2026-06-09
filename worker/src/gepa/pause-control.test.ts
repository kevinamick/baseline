import { describe, it, expect } from "vitest";
import {
  MAX_PROBE_DELAY_MS,
  PROBE_BACKOFF_COEFFICIENT,
  advancePauseWait,
  nextProbeDelayMs,
  startPauseWait,
  type PauseWaitState,
} from "./pause-control.js";

const MINUTE = 60 * 1000;

describe("startPauseWait", () => {
  it("starts with nothing elapsed and the first probe at the configured interval", () => {
    expect(startPauseWait(MINUTE)).toEqual({ elapsedMs: 0, delayMs: MINUTE });
  });
});

describe("nextProbeDelayMs", () => {
  it("backs off by the coefficient", () => {
    expect(nextProbeDelayMs(MINUTE)).toBe(MINUTE * PROBE_BACKOFF_COEFFICIENT);
  });

  it("caps at the max probe delay", () => {
    expect(nextProbeDelayMs(MAX_PROBE_DELAY_MS)).toBe(MAX_PROBE_DELAY_MS);
    expect(nextProbeDelayMs(MAX_PROBE_DELAY_MS - 1)).toBe(MAX_PROBE_DELAY_MS);
  });
});

describe("advancePauseWait", () => {
  const maxWaitMs = 24 * 60 * MINUTE; // the ~24h default cap

  it("resumes when the health probe succeeds", () => {
    const state = startPauseWait(MINUTE);
    expect(advancePauseWait(state, "probe-ok", maxWaitMs)).toEqual({ kind: "resume" });
  });

  it("resumes immediately on the retry-now signal (manual override beats the timer)", () => {
    const state = startPauseWait(MINUTE);
    expect(advancePauseWait(state, "retry-now", maxWaitMs)).toEqual({ kind: "resume" });
  });

  it("resumes on retry-now even when the cap would otherwise be exceeded", () => {
    const state: PauseWaitState = { elapsedMs: maxWaitMs, delayMs: MINUTE };
    expect(advancePauseWait(state, "retry-now", maxWaitMs)).toEqual({ kind: "resume" });
  });

  it("keeps waiting after a failed probe, accruing the waited delay and backing off", () => {
    const decision = advancePauseWait(startPauseWait(MINUTE), "probe-failed", maxWaitMs);
    expect(decision).toEqual({
      kind: "wait",
      state: { elapsedMs: MINUTE, delayMs: MINUTE * PROBE_BACKOFF_COEFFICIENT },
    });
  });

  it("gives up once total paused time reaches the max-wait cap", () => {
    const state: PauseWaitState = { elapsedMs: maxWaitMs - MINUTE, delayMs: MINUTE };
    expect(advancePauseWait(state, "probe-failed", maxWaitMs)).toEqual({ kind: "give-up" });
  });

  it("does not give up one step before the cap", () => {
    const state: PauseWaitState = { elapsedMs: maxWaitMs - MINUTE - 1, delayMs: MINUTE };
    const decision = advancePauseWait(state, "probe-failed", maxWaitMs);
    expect(decision.kind).toBe("wait");
  });

  it("walks the full backoff progression to give-up on a permanently-dead endpoint", () => {
    // 1m cap-equivalent walk with a tiny cap so the test enumerates real steps:
    // probes at 1m, 2m, 4m elapsed → cap 4m trips on the third failed probe.
    const cap = 4 * MINUTE;
    let state = startPauseWait(MINUTE);
    const d1 = advancePauseWait(state, "probe-failed", cap);
    expect(d1.kind).toBe("wait");
    state = (d1 as { kind: "wait"; state: PauseWaitState }).state;
    expect(state).toEqual({ elapsedMs: MINUTE, delayMs: 2 * MINUTE });

    const d2 = advancePauseWait(state, "probe-failed", cap);
    expect(d2.kind).toBe("wait");
    state = (d2 as { kind: "wait"; state: PauseWaitState }).state;
    expect(state).toEqual({ elapsedMs: 3 * MINUTE, delayMs: 4 * MINUTE });

    expect(advancePauseWait(state, "probe-failed", cap)).toEqual({ kind: "give-up" });
  });
});
