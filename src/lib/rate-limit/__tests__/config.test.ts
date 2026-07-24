import { describe, it, expect } from "vitest";
import { RATE_LIMITS, SURFACES, KEYTYPES } from "../config";

// Pin the entire threshold table with exact values (#209, ADR-0010). These
// numbers are the security control — a silently loosened limit or shrunken
// window is exactly the regression this test exists to catch.

const MINUTE = 60_000;
const HOUR = 3_600_000;

describe("RATE_LIMITS", () => {
  it("pins every surface's limits and windows exactly", () => {
    expect(RATE_LIMITS).toEqual({
      signIn: {
        email: { limit: 5, windowMs: 15 * MINUTE },
        ip: { limit: 20, windowMs: 15 * MINUTE },
      },
      signUp: {
        ip: { limit: 5, windowMs: HOUR },
      },
      requestPasswordReset: {
        email: { limit: 3, windowMs: HOUR },
        ip: { limit: 10, windowMs: HOUR },
      },
      resendConfirmation: {
        email: { limit: 3, windowMs: HOUR },
        ip: { limit: 10, windowMs: HOUR },
      },
      changeEmail: {
        user: { limit: 3, windowMs: HOUR },
      },
      exportAccountData: {
        user: { limit: 2, windowMs: HOUR },
      },
      inviteMember: {
        team: { limit: 20, windowMs: HOUR },
      },
      authConfirm: {
        ip: { limit: 20, windowMs: 15 * MINUTE },
      },
      authCallback: {
        ip: { limit: 20, windowMs: 15 * MINUTE },
      },
    });
  });

  it("uses real millisecond windows (15 min = 900000, 1 h = 3600000)", () => {
    // Guards the MINUTE/HOUR arithmetic itself against 60/MINUTE-style slips.
    expect(RATE_LIMITS.signIn.email?.windowMs).toBe(900_000);
    expect(RATE_LIMITS.signUp.ip?.windowMs).toBe(3_600_000);
  });

  it("has a rule table entry for every declared surface", () => {
    for (const surface of SURFACES) {
      const rules = RATE_LIMITS[surface];
      expect(Object.keys(rules).length).toBeGreaterThan(0);
      for (const keytype of Object.keys(rules)) {
        expect(KEYTYPES).toContain(keytype);
      }
    }
  });
});
