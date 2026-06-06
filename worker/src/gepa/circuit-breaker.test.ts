import { describe, it, expect } from "vitest";
import {
  AGENT_ENDPOINT_ERROR_TYPE,
  CIRCUIT_BREAKER_THRESHOLD,
  advanceBreaker,
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
