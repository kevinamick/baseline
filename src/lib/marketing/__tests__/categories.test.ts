import { describe, expect, it } from "vitest";
import type { AppLocale } from "@/i18n/routing";
import {
  CATEGORIES,
  CATEGORY_SLUGS,
  getCategory,
} from "@/lib/marketing/categories";

describe("category data", () => {
  it("ships the planned landers (category pages #278 + non-technical #279)", () => {
    expect([...CATEGORY_SLUGS].sort()).toEqual(
      [
        // #278 category pages
        "llm-as-judge",
        "llm-evaluation",
        "prompt-optimization",
        "rubric-based-evaluation",
        // #279 non-technical landers
        "ai-agent-testing",
        "reduce-ai-hallucinations",
      ].sort()
    );
  });

  it("has unique, url-safe slugs", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("declares the full tri-lingual locale set (localized in #280)", () => {
    for (const c of CATEGORIES) {
      // ADR-0013: now en/es/fr, since every page's translation landed in #280.
      expect([...c.locales].sort()).toEqual(["en", "es", "fr"]);
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
  it("defaults to canonical English and falls back to it for an untranslated locale", () => {
    const en = getCategory("llm-evaluation")!;
    // No locale arg → default (en).
    expect(getCategory("llm-evaluation", "en").heading).toBe(en.heading);
    // A locale with no translation returns English unchanged (the route's
    // locale-set guard never serves this case).
    expect(getCategory("llm-evaluation", "de" as AppLocale)?.heading).toBe(
      en.heading
    );
  });
});

describe("localized category content (#280)", () => {
  it("ships a complete es/fr translation for every advertised locale (no broken hreflang)", () => {
    for (const c of CATEGORIES) {
      const en = getCategory(c.slug, "en")!;
      for (const locale of c.locales) {
        if (locale === "en") continue;
        const localized = getCategory(c.slug, locale)!;
        // A real translation, not a silent English fallback.
        expect(localized.metaTitle).not.toBe(en.metaTitle);
        expect(localized.heading).not.toBe(en.heading);
        expect(localized.intro).not.toBe(en.intro);
        // ...and structurally complete: same number of sections as English.
        expect(localized.explainer.length).toBe(en.explainer.length);
        expect(localized.howBaseline.length).toBe(en.howBaseline.length);
        expect(localized.outcomes.length).toBe(en.outcomes.length);
        expect(localized.faqs.length).toBe(en.faqs.length);
        for (const para of localized.explainer) {
          expect(para.length).toBeGreaterThan(40);
        }
        for (const f of localized.howBaseline) {
          expect(f.feature.length).toBeGreaterThan(0);
          expect(f.body.length).toBeGreaterThan(0);
        }
        for (const faq of localized.faqs) {
          expect(faq.question.length).toBeGreaterThan(0);
          expect(faq.answer.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
