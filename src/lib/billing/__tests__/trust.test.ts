import { describe, it, expect } from "vitest";
import {
  PLANS,
  TRUST_ESCALATION_SCHEDULE,
  trustCeilingUsd,
  nextTrustTier,
} from "@/lib/billing/plans";

/**
 * Trust escalation — pure ceiling derivation (#188, ADR-0008). The schedule maps a
 * count of paid, un-reversed invoices to a multiple of the plan's default Managed
 * Spend Cap; these tests pin the derivation against fixtures. (Whether a given
 * invoice COUNTS — paid but not refunded/disputed — is the DB rule, covered in
 * trust.integration.test.ts; here the count is the input.)
 */

describe("TRUST_ESCALATION_SCHEDULE invariants", () => {
  it("starts at the plan default (×1) so a new Team can't self-raise above it", () => {
    expect(TRUST_ESCALATION_SCHEDULE[0]).toEqual({
      minPaidInvoices: 0,
      capMultiplier: 1,
    });
  });

  it("is sorted ascending and strictly escalating", () => {
    for (let i = 1; i < TRUST_ESCALATION_SCHEDULE.length; i++) {
      expect(TRUST_ESCALATION_SCHEDULE[i].minPaidInvoices).toBeGreaterThan(
        TRUST_ESCALATION_SCHEDULE[i - 1].minPaidInvoices,
      );
      expect(TRUST_ESCALATION_SCHEDULE[i].capMultiplier).toBeGreaterThan(
        TRUST_ESCALATION_SCHEDULE[i - 1].capMultiplier,
      );
    }
  });
});

describe("trustCeilingUsd", () => {
  const builderBase = PLANS.builder.defaultManagedSpendCapUsd!; // 25
  const scaleBase = PLANS.scale.defaultManagedSpendCapUsd!; // 100

  it("holds at the plan default through the initial tier (Builder)", () => {
    expect(trustCeilingUsd("builder", 0)).toBe(builderBase);
    expect(trustCeilingUsd("builder", 1)).toBe(builderBase);
  });

  it("steps up as paid-invoice history crosses each tier (Builder)", () => {
    expect(trustCeilingUsd("builder", 2)).toBe(builderBase * 2);
    expect(trustCeilingUsd("builder", 3)).toBe(builderBase * 2);
    expect(trustCeilingUsd("builder", 4)).toBe(builderBase * 4);
    expect(trustCeilingUsd("builder", 7)).toBe(builderBase * 4);
    expect(trustCeilingUsd("builder", 8)).toBe(builderBase * 8);
  });

  it("caps at the top tier no matter how many invoices (Builder)", () => {
    expect(trustCeilingUsd("builder", 8)).toBe(builderBase * 8);
    expect(trustCeilingUsd("builder", 1_000)).toBe(builderBase * 8);
  });

  it("scales each plan from its own default off the shared schedule (Scale)", () => {
    expect(trustCeilingUsd("scale", 0)).toBe(scaleBase);
    expect(trustCeilingUsd("scale", 2)).toBe(scaleBase * 2);
    expect(trustCeilingUsd("scale", 8)).toBe(scaleBase * 8);
  });

  it("is null for plans without managed spend (Free)", () => {
    expect(trustCeilingUsd("free", 0)).toBeNull();
    expect(trustCeilingUsd("free", 100)).toBeNull();
  });
});

describe("nextTrustTier", () => {
  it("points at the next unlock for a Team below the top (Builder)", () => {
    expect(nextTrustTier("builder", 0)).toEqual({
      atPaidInvoices: 2,
      ceilingUsd: PLANS.builder.defaultManagedSpendCapUsd! * 2,
    });
    expect(nextTrustTier("builder", 1)).toEqual({
      atPaidInvoices: 2,
      ceilingUsd: PLANS.builder.defaultManagedSpendCapUsd! * 2,
    });
    expect(nextTrustTier("builder", 2)).toEqual({
      atPaidInvoices: 4,
      ceilingUsd: PLANS.builder.defaultManagedSpendCapUsd! * 4,
    });
  });

  it("is null once a Team is at the top tier (Builder)", () => {
    expect(nextTrustTier("builder", 8)).toBeNull();
    expect(nextTrustTier("builder", 50)).toBeNull();
  });

  it("is null for plans without managed spend (Free)", () => {
    expect(nextTrustTier("free", 0)).toBeNull();
  });
});
