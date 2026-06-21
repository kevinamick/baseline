import { describe, expect, it } from "vitest";
import type { AppLocale } from "@/i18n/routing";
import { COMPARISONS, getComparison } from "@/lib/marketing/comparisons";

describe("comparison data", () => {
  it("has unique, url-safe slugs", () => {
    const slugs = COMPARISONS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("declares the full tri-lingual locale set (localized in #280)", () => {
    for (const c of COMPARISONS) {
      // ADR-0013: now en/es/fr, since every page's translation landed in #280.
      expect([...c.locales].sort()).toEqual(["en", "es", "fr"]);
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
  it("resolves every shipped competitor page", () => {
    expect(getComparison("langsmith")?.competitor).toBe("LangSmith");
    expect(getComparison("humanloop")?.competitor).toBe("Humanloop");
    expect(getComparison("langfuse")?.competitor).toBe("Langfuse");
  });
  it("returns undefined for an unknown slug", () => {
    expect(getComparison("nope")).toBeUndefined();
  });
  it("defaults to canonical English and falls back to it for an untranslated locale", () => {
    const en = getComparison("braintrust")!;
    expect(getComparison("braintrust", "en").intro).toBe(en.intro);
    expect(getComparison("braintrust", "de" as AppLocale)?.intro).toBe(en.intro);
  });
});

describe("localized comparison content (#280)", () => {
  it("ships a complete es/fr translation for every advertised locale (no broken hreflang)", () => {
    for (const c of COMPARISONS) {
      const en = getComparison(c.slug, "en")!;
      for (const locale of c.locales) {
        if (locale === "en") continue;
        const localized = getComparison(c.slug, locale)!;
        // A real translation, not a silent English fallback.
        expect(localized.metaTitle).not.toBe(en.metaTitle);
        expect(localized.intro).not.toBe(en.intro);
        // ...structurally complete, and rows keep resolvable source ids.
        expect(localized.rows.length).toBe(en.rows.length);
        expect(localized.whyBaseline.length).toBe(en.whyBaseline.length);
        const ids = new Set(localized.sources.map((s) => s.id));
        for (const row of localized.rows) {
          expect(row.dimension.length).toBeGreaterThan(0);
          expect(row.baseline.length).toBeGreaterThan(0);
          expect(row.competitor.length).toBeGreaterThan(0);
          if (row.sourceId) expect(ids.has(row.sourceId)).toBe(true);
        }
      }
    }
  });
});
