import { describe, it, expect } from "vitest";
import {
  advancePauseMachine,
  startPauseMachine,
  type PauseMachineConfig,
  type PauseMachineState,
} from "./pause-machine.js";

const MINUTE = 60 * 1000;

function config(overrides: Partial<PauseMachineConfig> = {}): PauseMachineConfig {
  return {
    probeIntervalMs: MINUTE,
    maxWaitMs: 24 * 60 * MINUTE,
    initialElapsedMs: 0,
    ...overrides,
  };
}

describe("startPauseMachine", () => {
  it("enters by commanding the pause be recorded", () => {
    expect(startPauseMachine()).toEqual({
      state: { kind: "entering" },
      effect: { kind: "call-pause-run" },
    });
  });
});

describe("advancePauseMachine — enter-pause", () => {
  it("starts the first wait at the configured probe interval once the pause is recorded", () => {
    const { state, effect } = advancePauseMachine(
      { kind: "entering" },
      { kind: "pause-recorded" },
      config()
    );
    expect(state).toEqual({ kind: "waiting", wait: { elapsedMs: 0, delayMs: MINUTE } });
    expect(effect).toEqual({ kind: "wait", delayMs: MINUTE });
  });

  it("carries paused time accrued in earlier episodes into the first wait", () => {
    const { state } = advancePauseMachine(
      { kind: "entering" },
      { kind: "pause-recorded" },
      config({ initialElapsedMs: 7 * MINUTE })
    );
    expect(state).toEqual({ kind: "waiting", wait: { elapsedMs: 7 * MINUTE, delayMs: MINUTE } });
  });
});

describe("advancePauseMachine — waiting", () => {
  const waitingState: PauseMachineState = { kind: "waiting", wait: { elapsedMs: 0, delayMs: MINUTE } };

  it("moves to probing once the backoff timer elapses", () => {
    const { state, effect } = advancePauseMachine(waitingState, { kind: "wait-elapsed" }, config());
    expect(state).toEqual({ kind: "probing", wait: waitingState.wait });
    expect(effect).toEqual({ kind: "call-probe" });
  });

  it("resumes immediately on the retry-now signal, without ever probing", () => {
    const { state, effect } = advancePauseMachine(waitingState, { kind: "wait-signalled" }, config());
    expect(state).toEqual({ kind: "resuming", wait: waitingState.wait });
    expect(effect).toEqual({ kind: "call-resume-run" });
  });
});

describe("advancePauseMachine — probing", () => {
  const probingState: PauseMachineState = { kind: "probing", wait: { elapsedMs: 0, delayMs: MINUTE } };

  it("resumes when the probe reports healthy", () => {
    const { state, effect } = advancePauseMachine(
      probingState,
      { kind: "probe-result", healthy: true },
      config()
    );
    expect(state).toEqual({ kind: "resuming", wait: probingState.wait });
    expect(effect).toEqual({ kind: "call-resume-run" });
  });

  it("backs off and waits again when the probe reports unhealthy, with budget left", () => {
    const { state, effect } = advancePauseMachine(
      probingState,
      { kind: "probe-result", healthy: false },
      config()
    );
    expect(state).toEqual({
      kind: "waiting",
      wait: { elapsedMs: MINUTE, delayMs: 2 * MINUTE },
    });
    expect(effect).toEqual({ kind: "wait", delayMs: 2 * MINUTE });
  });

  it("gives up once a failed probe pushes total paused time to the max-wait cap", () => {
    const cap = MINUTE;
    const { state, effect } = advancePauseMachine(
      probingState,
      { kind: "probe-result", healthy: false },
      config({ maxWaitMs: cap })
    );
    expect(state).toEqual({ kind: "given-up", wait: probingState.wait });
    expect(effect).toEqual({ kind: "give-up" });
  });

  it("a retry-now signal discovered after the probe settled still resumes (manual override wins)", () => {
    const { state, effect } = advancePauseMachine(probingState, { kind: "wait-signalled" }, config());
    expect(state).toEqual({ kind: "resuming", wait: probingState.wait });
    expect(effect).toEqual({ kind: "call-resume-run" });
  });
});

describe("advancePauseMachine — resuming", () => {
  it("finishes once the resume is recorded", () => {
    const wait = { elapsedMs: 3 * MINUTE, delayMs: 4 * MINUTE };
    const { state, effect } = advancePauseMachine(
      { kind: "resuming", wait },
      { kind: "resume-recorded" },
      config()
    );
    expect(state).toEqual({ kind: "resumed", wait });
    expect(effect).toEqual({ kind: "none" });
  });
});

describe("advancePauseMachine — invalid transitions", () => {
  it("rejects an event that can't occur in the given state", () => {
    expect(() =>
      advancePauseMachine({ kind: "entering" }, { kind: "wait-elapsed" }, config())
    ).toThrow(/invalid in state "entering"/);
  });

  it("rejects any event fed to a terminal state", () => {
    const resumed: PauseMachineState = { kind: "resumed", wait: { elapsedMs: 0, delayMs: MINUTE } };
    expect(() => advancePauseMachine(resumed, { kind: "pause-recorded" }, config())).toThrow();

    const givenUp: PauseMachineState = { kind: "given-up", wait: { elapsedMs: 0, delayMs: MINUTE } };
    expect(() => advancePauseMachine(givenUp, { kind: "pause-recorded" }, config())).toThrow();
  });
});

describe("advancePauseMachine — full episode walk", () => {
  it("walks enter → backoff-then-recover → resume", () => {
    let { state, effect } = startPauseMachine();
    expect(effect).toEqual({ kind: "call-pause-run" });

    ({ state, effect } = advancePauseMachine(state, { kind: "pause-recorded" }, config()));
    expect(effect).toEqual({ kind: "wait", delayMs: MINUTE });

    ({ state, effect } = advancePauseMachine(state, { kind: "wait-elapsed" }, config()));
    expect(effect).toEqual({ kind: "call-probe" });

    ({ state, effect } = advancePauseMachine(state, { kind: "probe-result", healthy: false }, config()));
    expect(effect).toEqual({ kind: "wait", delayMs: 2 * MINUTE });

    ({ state, effect } = advancePauseMachine(state, { kind: "wait-elapsed" }, config()));
    expect(effect).toEqual({ kind: "call-probe" });

    ({ state, effect } = advancePauseMachine(state, { kind: "probe-result", healthy: true }, config()));
    expect(effect).toEqual({ kind: "call-resume-run" });

    ({ state, effect } = advancePauseMachine(state, { kind: "resume-recorded" }, config()));
    expect(state.kind).toBe("resumed");
    expect(effect).toEqual({ kind: "none" });
    if (state.kind === "resumed") {
      // Only the one FAILED probe's wait accrued; the second (successful) probe resumes without
      // adding to the elapsed total (advancePauseWait only advances the clock on a failure).
      expect(state.wait.elapsedMs).toBe(1 * MINUTE);
    }
  });

  it("walks enter → manual retry-now signal → resume, skipping the probe entirely", () => {
    let { state, effect } = startPauseMachine();
    ({ state, effect } = advancePauseMachine(state, { kind: "pause-recorded" }, config()));
    expect(effect).toEqual({ kind: "wait", delayMs: MINUTE });

    ({ state, effect } = advancePauseMachine(state, { kind: "wait-signalled" }, config()));
    expect(effect).toEqual({ kind: "call-resume-run" });

    ({ state, effect } = advancePauseMachine(state, { kind: "resume-recorded" }, config()));
    expect(state.kind).toBe("resumed");
    if (state.kind === "resumed") {
      expect(state.wait.elapsedMs).toBe(0); // never waited out a failed probe
    }
  });

  it("walks enter → sustained probe failures → give-up", () => {
    const cap = 4 * MINUTE;
    let { state, effect } = startPauseMachine();
    ({ state, effect } = advancePauseMachine(state, { kind: "pause-recorded" }, config({ maxWaitMs: cap })));
    ({ state, effect } = advancePauseMachine(state, { kind: "wait-elapsed" }, config({ maxWaitMs: cap })));
    ({ state, effect } = advancePauseMachine(
      state,
      { kind: "probe-result", healthy: false },
      config({ maxWaitMs: cap })
    ));
    expect(effect).toEqual({ kind: "wait", delayMs: 2 * MINUTE });

    ({ state, effect } = advancePauseMachine(state, { kind: "wait-elapsed" }, config({ maxWaitMs: cap })));
    ({ state, effect } = advancePauseMachine(
      state,
      { kind: "probe-result", healthy: false },
      config({ maxWaitMs: cap })
    ));
    expect(effect).toEqual({ kind: "wait", delayMs: 4 * MINUTE });

    ({ state, effect } = advancePauseMachine(state, { kind: "wait-elapsed" }, config({ maxWaitMs: cap })));
    ({ state, effect } = advancePauseMachine(
      state,
      { kind: "probe-result", healthy: false },
      config({ maxWaitMs: cap })
    ));
    expect(state.kind).toBe("given-up");
    expect(effect).toEqual({ kind: "give-up" });
  });
});
