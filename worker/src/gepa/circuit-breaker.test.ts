import { describe, it, expect } from "vitest";
import {
  AGENT_ENDPOINT_ERROR_TYPE,
  CIRCUIT_BREAKER_THRESHOLD,
  advanceBreaker,
  advancePlateau,
  isEndpointFailure,
} from "./circuit-breaker.js";

describe("isEndpointFailure", () => {
  it("matches a direct ApplicationFailure-shaped error with the endpoint type", () => {
    expect(isEndpointFailure({ type: AGENT_ENDPOINT_ERROR_TYPE })).toBe(true);
  });

  it("matches the marker nested in a cause chain (ActivityFailure -> ApplicationFailure)", () => {
    // How Temporal surfaces it in the workflow: ActivityFailure wraps the ApplicationFailure.
    const activityFailure = {
      name: "ActivityFailure",
      message: "Activity task failed",
      cause: { name: "ApplicationFailure", type: AGENT_ENDPOINT_ERROR_TYPE, message: "unreachable" },
    };
    expect(isEndpointFailure(activityFailure)).toBe(true);
  });

  it("is false for a non-endpoint failure (e.g. the reflection model)", () => {
    const other = {
      name: "ActivityFailure",
      cause: { name: "ApplicationFailure", type: "Error", message: "propose failed" },
    };
    expect(isEndpointFailure(other)).toBe(false);
  });

  it("is false for null / undefined / non-objects", () => {
    expect(isEndpointFailure(null)).toBe(false);
    expect(isEndpointFailure(undefined)).toBe(false);
    expect(isEndpointFailure("AgentEndpointError")).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const a: { type: string; cause?: unknown } = { type: "Error" };
    const b: { type: string; cause?: unknown } = { type: "Error", cause: a };
    a.cause = b; // cycle
    expect(isEndpointFailure(a)).toBe(false);
  });
});

describe("advanceBreaker", () => {
  it("increments on consecutive endpoint failures and trips at the threshold", () => {
    let consecutive = 0;
    for (let i = 1; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      const state = advanceBreaker(consecutive, "endpoint-failure");
      consecutive = state.consecutive;
      expect(state.consecutive).toBe(i);
      expect(state.tripped).toBe(false);
    }
    const tripping = advanceBreaker(consecutive, "endpoint-failure");
    expect(tripping.consecutive).toBe(CIRCUIT_BREAKER_THRESHOLD);
    expect(tripping.tripped).toBe(true);
  });

  it("resets the streak on a successful iteration", () => {
    expect(advanceBreaker(2, "ok")).toEqual({ consecutive: 0, tripped: false });
  });

  it("resets the streak on a non-endpoint failure (the endpoint isn't what's broken)", () => {
    expect(advanceBreaker(2, "other-failure")).toEqual({ consecutive: 0, tripped: false });
  });

  it("respects a custom threshold", () => {
    expect(advanceBreaker(0, "endpoint-failure", 1)).toEqual({ consecutive: 1, tripped: true });
  });
});

describe("advancePlateau", () => {
  it("advances on a successful iteration with no frontier gain", () => {
    expect(advancePlateau(1, "ok", false)).toBe(2);
  });

  it("resets on a successful iteration that gains the frontier", () => {
    expect(advancePlateau(3, "ok", true)).toBe(0);
  });

  it("leaves the counter unchanged on an endpoint failure (the breaker's domain, not plateau's)", () => {
    // The masking bug: counting this as a plateau let plateau_patience < breaker threshold
    // terminate a dead-endpoint run on the seed before the breaker could fire.
    expect(advancePlateau(1, "endpoint-failure", false)).toBe(1);
  });

  it("leaves the counter unchanged on a non-endpoint failure", () => {
    expect(advancePlateau(2, "other-failure", false)).toBe(2);
  });
});
