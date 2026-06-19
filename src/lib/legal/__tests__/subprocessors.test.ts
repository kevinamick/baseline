import { describe, it, expect } from "vitest";
import {
  SUBPROCESSORS,
  SUBPROCESSOR_CATEGORIES,
} from "../subprocessors";

describe("SUBPROCESSORS", () => {
  it("discloses every third party the app is wired to", () => {
    const names = SUBPROCESSORS.map((s) => s.name);
    for (const expected of ["Supabase", "Stripe", "Resend", "PostHog"]) {
      expect(names).toContain(expected);
    }
  });

  it("gives each entry a non-empty purpose, data, region, and valid category", () => {
    for (const s of SUBPROCESSORS) {
      expect(s.purpose.length).toBeGreaterThan(0);
      expect(s.data.length).toBeGreaterThan(0);
      expect(s.region.length).toBeGreaterThan(0);
      expect(SUBPROCESSOR_CATEGORIES).toContain(s.category);
    }
  });

  it("classifies PostHog as consent-gated analytics", () => {
    const analytics = SUBPROCESSORS.filter(
      (s) => s.category === "analytics",
    ).map((s) => s.name);
    expect(analytics).toEqual(["PostHog"]);
  });
});
