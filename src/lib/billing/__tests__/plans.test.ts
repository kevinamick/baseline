import { describe, it, expect, beforeEach } from "vitest";
import {
  PLANS,
  PLAN_SLUGS,
  PAID_PLAN_SLUGS,
  ORDERED_PLANS,
  isPlanSlug,
  isPaidPlanSlug,
  priceIdForPlan,
  planForPriceId,
} from "../plans";

beforeEach(() => {
  process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
  process.env.STRIPE_PRICE_SCALE = "price_scale_live";
});

describe("plan definitions integrity", () => {
  it("defines every slug exactly once, ordered cheapest-first", () => {
    expect(PLAN_SLUGS).toEqual(["free", "builder", "scale"]);
    expect(ORDERED_PLANS.map((p) => p.slug)).toEqual([...PLAN_SLUGS]);
    expect(ORDERED_PLANS.map((p) => p.monthlyPriceUsd)).toEqual([0, 49, 199]);
  });

  it("every plan has every quota field populated", () => {
    for (const slug of PLAN_SLUGS) {
      const p = PLANS[slug];
      expect(p.slug).toBe(slug);
      expect(p.name).toBeTruthy();
      expect(p.audience).toBeTruthy();
      expect(typeof p.monthlyPriceUsd).toBe("number");
      expect(typeof p.includedEvalPoints).toBe("number");
      expect(typeof p.includedOptimizationRuns).toBe("number");
      expect(typeof p.retentionDays).toBe("number");
      // Nullable-but-required fields must be present (null is a valid value).
      expect(p).toHaveProperty("seatLimit");
      expect(p).toHaveProperty("evalPointOverageUsd");
      expect(p).toHaveProperty("managedMarkupPct");
      expect(p).toHaveProperty("defaultManagedSpendCapUsd");
      expect(p).toHaveProperty("managedInvoiceThresholdUsd");
      expect(p).toHaveProperty("priceEnvVar");
    }
  });

  it("threshold billing fires below the managed spend cap, and only where managed applies (#186)", () => {
    // Free is BYO-only: no managed, so no cap and no threshold.
    expect(PLANS.free.managedInvoiceThresholdUsd).toBeNull();
    expect(PLANS.free.defaultManagedSpendCapUsd).toBeNull();
    // Paid plans bound un-invoiced credit strictly below the spend cap, so the
    // threshold invoice fires before a Team can sit at a full unpaid cap.
    for (const slug of PAID_PLAN_SLUGS) {
      const p = PLANS[slug];
      expect(p.managedInvoiceThresholdUsd).not.toBeNull();
      expect(p.defaultManagedSpendCapUsd).not.toBeNull();
      expect(p.managedInvoiceThresholdUsd!).toBeGreaterThan(0);
      expect(p.managedInvoiceThresholdUsd!).toBeLessThan(p.defaultManagedSpendCapUsd!);
    }
  });

  it("matches the published pricing model (#137)", () => {
    expect(PLANS.free).toMatchObject({
      seatLimit: 1,
      includedEvalPoints: 5_000,
      includedOptimizationRuns: 1, // one LIFETIME run — never resets
      optimizationRunsGrant: "lifetime",
      maxBudgetRollouts: 100,
      evalPointOverageUsd: null, // hard stop
      retentionDays: 14,
      managedMarkupPct: null, // BYO only
      priceEnvVar: null, // no checkout
    });
    expect(PLANS.builder).toMatchObject({
      monthlyPriceUsd: 49,
      seatLimit: null,
      includedEvalPoints: 100_000,
      includedOptimizationRuns: 15,
      optimizationRunsGrant: "per_period",
      retentionDays: 90,
      managedMarkupPct: 40,
    });
    expect(PLANS.scale).toMatchObject({
      monthlyPriceUsd: 199,
      includedEvalPoints: 500_000,
      includedOptimizationRuns: 75,
      optimizationRunsGrant: "per_period",
      retentionDays: 1_095,
      managedMarkupPct: 30,
    });
  });

  it("only Builder and Scale are paid/subscribable", () => {
    expect(PAID_PLAN_SLUGS).toEqual(["builder", "scale"]);
    expect(PLANS.free.priceEnvVar).toBeNull();
  });
});

describe("isPlanSlug / isPaidPlanSlug", () => {
  it("accepts known slugs and rejects everything else", () => {
    expect(isPlanSlug("builder")).toBe(true);
    expect(isPlanSlug("free")).toBe(true);
    expect(isPlanSlug("platinum")).toBe(false);
    expect(isPlanSlug(null)).toBe(false);
    expect(isPlanSlug(42)).toBe(false);
  });

  it("treats Free as a plan but not a paid plan", () => {
    expect(isPaidPlanSlug("free")).toBe(false);
    expect(isPaidPlanSlug("builder")).toBe(true);
    expect(isPaidPlanSlug("nope")).toBe(false);
  });
});

describe("priceIdForPlan", () => {
  it("resolves the price id from env per paid plan", () => {
    expect(priceIdForPlan("builder")).toBe("price_builder_live");
    expect(priceIdForPlan("scale")).toBe("price_scale_live");
  });

  it("throws when the env var is missing (fail loud, never wrong price)", () => {
    delete process.env.STRIPE_PRICE_BUILDER;
    expect(() => priceIdForPlan("builder")).toThrow(/Missing env/);
  });
});

describe("planForPriceId", () => {
  it("maps a known price id back to its plan", () => {
    expect(planForPriceId("price_builder_live")).toBe("builder");
    expect(planForPriceId("price_scale_live")).toBe("scale");
  });

  it("returns null for an unknown/retired price or null", () => {
    expect(planForPriceId("price_retired")).toBeNull();
    expect(planForPriceId(null)).toBeNull();
  });
});
