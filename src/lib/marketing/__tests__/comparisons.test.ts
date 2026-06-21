import { describe, expect, it } from "vitest";
import {
  COMPARISONS,
  comparisonStaticParams,
  getComparison,
} from "@/lib/marketing/comparisons";

describe("comparison data", () => {
  it("has unique, url-safe slugs", () => {
    const slugs = COMPARISONS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("declares a non-empty locale set with the launch locale", () => {
    for (const c of COMPARISONS) {
      expect(c.locales.length).toBeGreaterThan(0);
      // ADR-0013: English-only at launch.
      expect(c.locales).toContain("en");
    }
  });

  it("stamps every comparison with an ISO `as of` date", () => {
    for (const c of COMPARISONS) {
      expect(c.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(c.asOf))).toBe(false);
    }
  });

  it("backs every cited row with a resolvable, https source", () => {
    for (const c of COMPARISONS) {
      const ids = new Set(c.sources.map((s) => s.id));
      for (const row of c.rows) {
        if (row.sourceId) expect(ids.has(row.sourceId)).toBe(true);
      }
      for (const source of c.sources) {
        expect(source.url).toMatch(/^https:\/\//);
      }
    }
  });

  it("has at least one comparison row and one why-Baseline outcome", () => {
    for (const c of COMPARISONS) {
      expect(c.rows.length).toBeGreaterThan(0);
      expect(c.whyBaseline.length).toBeGreaterThan(0);
    }
  });
});

describe("getComparison", () => {
  it("resolves a known slug", () => {
    expect(getComparison("braintrust")?.competitor).toBe("Braintrust");
  });
  it("returns undefined for an unknown slug", () => {
    expect(getComparison("nope")).toBeUndefined();
  });
});

describe("comparisonStaticParams", () => {
  it("returns every comparison for the launch locale", () => {
    expect(comparisonStaticParams("en")).toEqual([{ competitor: "braintrust" }]);
  });

  it("returns nothing for locales no comparison exists in yet (so they 404)", () => {
    // ADR-0013: with dynamicParams=false, an empty set means /es|fr/compare/* 404.
    expect(comparisonStaticParams("es")).toEqual([]);
    expect(comparisonStaticParams("fr")).toEqual([]);
  });
});
