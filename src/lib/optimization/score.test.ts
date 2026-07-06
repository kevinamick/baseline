import { describe, it, expect } from "vitest";
import { hasLift } from "./score";

describe("hasLift", () => {
  it("is true only when best meaningfully exceeds seed", () => {
    expect(hasLift(0.62, 0.81)).toBe(true);
  });

  it("is false when the winner merely re-derives the seed score", () => {
    expect(hasLift(0.81, 0.81)).toBe(false);
    expect(hasLift(0.81, 0.810001)).toBe(false);
  });

  it("is false when best is below seed", () => {
    expect(hasLift(0.81, 0.62)).toBe(false);
  });

  it("is false when either score is unknown", () => {
    expect(hasLift(null, 0.81)).toBe(false);
    expect(hasLift(0.62, null)).toBe(false);
  });
});
