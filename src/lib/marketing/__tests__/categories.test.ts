import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CATEGORY_SLUGS,
  getCategory,
} from "@/lib/marketing/categories";

describe("category data", () => {
  it("ships exactly the four planned landers", () => {
    expect([...CATEGORY_SLUGS].sort()).toEqual(
      [
        "llm-as-judge",
        "llm-evaluation",
        "prompt-optimization",
        "rubric-based-evaluation",
      ].sort()
    );
  });

  it("has unique, url-safe slugs", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("declares a non-empty locale set with the launch locale", () => {
    for (const c of CATEGORIES) {
      expect(c.locales.length).toBeGreaterThan(0);
      // ADR-0013: English-only at launch.
      expect(c.locales).toContain("en");
    }
  });

  it("gives every page a distinct angle, heading, and meta (no doorway overlap)", () => {
    // Structural anti-cannibalization guard — a duplicated angle/heading/meta is the
    // mechanical signature of doorway pages (the editorial call is the review's).
    for (const field of [
      "angle",
      "heading",
      "metaTitle",
      "metaDescription",
    ] as const) {
      const values = CATEGORIES.map((c) => c[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("carries real prose on every page (not a thin stub)", () => {
    for (const c of CATEGORIES) {
      expect(c.intro.length).toBeGreaterThan(0);
      expect(c.explainer.length).toBeGreaterThan(0);
      expect(c.howBaseline.length).toBeGreaterThan(0);
      expect(c.outcomes.length).toBeGreaterThan(0);
      expect(c.faqs.length).toBeGreaterThan(0);
      for (const para of c.explainer) expect(para.length).toBeGreaterThan(40);
      for (const f of c.howBaseline) {
        expect(f.feature.length).toBeGreaterThan(0);
        expect(f.body.length).toBeGreaterThan(0);
      }
      for (const faq of c.faqs) {
        expect(faq.question.length).toBeGreaterThan(0);
        expect(faq.answer.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("getCategory", () => {
  it("resolves every shipped slug", () => {
    for (const slug of CATEGORY_SLUGS) {
      expect(getCategory(slug)?.slug).toBe(slug);
    }
  });
  it("returns undefined for an unknown slug", () => {
    expect(getCategory("nope")).toBeUndefined();
  });
});
