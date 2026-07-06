import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppLocale } from "@/i18n/routing";
import {
  CATEGORIES,
  CATEGORY_SLUGS,
  getCategory,
  type Category,
  type CategoryStep,
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
        // product guides
        "simple-prompt-optimization",
        "ai-eval-pricing",
        // #432 DIY guide
        "manual-prompt-optimization",
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
      expect(c.walkthrough.length).toBeGreaterThanOrEqual(3);
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
      const steps: readonly CategoryStep[] = c.walkthrough;
      for (const step of steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.body.length).toBeGreaterThan(40);
        if (step.image) expect(step.image.alt.length).toBeGreaterThan(20);
      }
    }
  });

  it("every walkthrough screenshot exists under public/ and is referenced with a /docs path", () => {
    // A renamed or missing screenshot is a broken image on a marketing page —
    // catch it at test time, not in production.
    for (const c of CATEGORIES) {
      const steps: readonly CategoryStep[] = c.walkthrough;
      for (const step of steps) {
        if (!step.image) continue;
        expect(step.image.src).toMatch(/^\/docs\/[a-z0-9-]+\.png$/);
        expect(
          existsSync(join(process.cwd(), "public", step.image.src)),
          `${c.slug}: missing ${step.image.src}`
        ).toBe(true);
      }
    }
  });
});

// #432: the manual-optimization guide is a trust play aimed at a non-technical
// buyer, so it must read as a genuine standalone how-to, never a thin wrapper
// leaking Baseline's internal technique lexicon. Enforced across every locale,
// including the copy-paste prompt block, which is the surface most likely to
// pick up jargon if machine-translated or drafted by an assistant that knows
// the underlying technique by name.
describe("vocabulary firewall (#432)", () => {
  const FORBIDDEN_TERMS = [
    "GEPA",
    "Reflection",
    "Reflective",
    "Candidate",
    "Rollout",
    "Module",
    "Pareto",
    "mutation",
    "crossover",
  ];

  /** Every user-facing string on a category entry, flattened for scanning. */
  function allStrings(c: Category): string[] {
    const out: string[] = [
      c.metaTitle,
      c.metaDescription,
      c.heading,
      c.ogSubtitle,
      c.intro,
      ...c.explainer,
    ];
    for (const step of c.walkthrough) {
      out.push(step.title, step.body);
      if (step.image) out.push(step.image.alt);
      if (step.codeBlock) out.push(step.codeBlock);
    }
    for (const f of c.howBaseline) out.push(f.feature, f.body);
    if (c.closingLink) out.push(c.closingLink.label);
    out.push(...c.outcomes);
    for (const faq of c.faqs) out.push(faq.question, faq.answer);
    return out;
  }

  it("keeps the product/technique lexicon off /manual-prompt-optimization in every locale", () => {
    for (const locale of ["en", "es", "fr"] as const) {
      const category = getCategory("manual-prompt-optimization", locale)!;
      const haystack = allStrings(category).join("\n");
      for (const term of FORBIDDEN_TERMS) {
        expect(
          haystack,
          `${locale}: found forbidden term "${term}" on manual-prompt-optimization`
        ).not.toMatch(new RegExp(term, "i"));
      }
    }
  });

  it("keeps Baseline out of the body until the closer, in every locale", () => {
    for (const locale of ["en", "es", "fr"] as const) {
      const category = getCategory("manual-prompt-optimization", locale)!;
      // Everything up to (not including) the howBaseline closer and its closing
      // link must read as a standalone guide, with no brand mention. Meta fields
      // (title/description/OG subtitle) are excluded: every category page brands
      // those the same way, and they aren't part of the on-page reading body.
      const preCloser = [category.heading, category.intro, ...category.explainer];
      for (const step of category.walkthrough) {
        preCloser.push(step.title, step.body);
        if (step.codeBlock) preCloser.push(step.codeBlock);
      }
      const haystack = preCloser.join("\n");
      expect(
        haystack,
        `${locale}: "Baseline" appears before the closer on manual-prompt-optimization`
      ).not.toMatch(/baseline/i);
    }
  });

  it("names LangSmith and Braintrust only in the eval-scoring step, in every locale", () => {
    for (const locale of ["en", "es", "fr"] as const) {
      const category = getCategory("manual-prompt-optimization", locale)!;
      for (const [i, step] of category.walkthrough.entries()) {
        const mentionsCompetitor = /langsmith|braintrust/i.test(step.body);
        if (mentionsCompetitor) {
          expect(
            i,
            `${locale}: competitor mention outside the scoring step (step ${i})`
          ).toBe(1);
        }
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
    expect(getCategory("llm-evaluation", "en")?.heading).toBe(en.heading);
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
        expect(localized.walkthrough.length).toBe(en.walkthrough.length);
        expect(localized.howBaseline.length).toBe(en.howBaseline.length);
        expect(localized.outcomes.length).toBe(en.outcomes.length);
        expect(localized.faqs.length).toBe(en.faqs.length);
        // Walkthrough steps are translated prose over the SAME screenshots: the
        // src must match English byte-for-byte, the alt must be a real translation.
        for (let i = 0; i < localized.walkthrough.length; i++) {
          const enStep = en.walkthrough[i];
          const locStep = localized.walkthrough[i];
          expect(locStep.image?.src).toBe(enStep.image?.src);
          if (enStep.image) {
            expect(locStep.image!.alt).not.toBe(enStep.image.alt);
          }
          expect(locStep.title).not.toBe(enStep.title);
        }
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
