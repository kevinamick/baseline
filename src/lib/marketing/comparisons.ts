import type { AppLocale } from "@/i18n/routing";

/**
 * The competitor comparison surface (ADR-0013), as a single typed data file. Each
 * entry drives one `/compare/{slug}` page end-to-end: routing, metadata, the
 * rendered table, the dynamic OG image, and the sitemap. Adding a competitor is a
 * data-only change — no new page wiring — which is the reuse this tracer proves.
 *
 * Editorial rules (from the SEO plan, enforced at review):
 * - Claims are objective and verifiable only — never disparaging, never a value
 *   judgement. Each row's competitor cell must be checkable against its `sourceId`.
 * - Every comparison carries an `asOf` date, rendered on-page, so a reader knows
 *   when the claims were last verified and stale facts are obvious.
 * - Audience is the non-technical buyer: outcome/ROI-led, plain language, glossary
 *   vocabulary (Rubric, Eval Run, Schedule, Optimization Run) over jargon.
 */

/** A linked, citable source backing one or more comparison rows. */
export interface ComparisonSource {
  /** Stable id referenced by a row's `sourceId`. */
  id: string;
  label: string;
  /** Must be an absolute https URL to a public page. */
  url: string;
}

/** One row of the side-by-side table: a neutral dimension and each side's facts. */
export interface ComparisonRow {
  /** The dimension being compared, e.g. "Automated prompt optimization". */
  dimension: string;
  /** Baseline's factual approach. */
  baseline: string;
  /** The competitor's factual approach, verifiable against `sourceId`. */
  competitor: string;
  /** Source backing the competitor cell (id into `sources`). */
  sourceId?: string;
}

export interface Comparison {
  /** Flat URL slug: `/compare/{slug}`. */
  slug: string;
  /** Competitor display name (proper noun, never translated). */
  competitor: string;
  /**
   * The set of locales this page actually exists in (ADR-0013). `["en"]` at
   * launch: only `en` is prerendered, the page self-canonicals and emits no
   * `es`/`fr` `hreflang`, and `/es|fr/compare/{slug}` are not crawlable. Widen
   * this **only** when the matching translation actually lands (issue #280) —
   * never "to match the rest of the app" (see ADR-0013's failure-mode note).
   */
  locales: readonly AppLocale[];
  /** `<title>` and OG/Twitter title. Brand-led: "Baseline vs Braintrust". */
  metaTitle: string;
  metaDescription: string;
  /** On-page H1. */
  heading: string;
  /** Outcome/ROI-led intro paragraph for a non-technical buyer. */
  intro: string;
  /** ISO date (YYYY-MM-DD) the competitor claims were last verified. */
  asOf: string;
  /** Outcome-led reasons to choose Baseline, in glossary vocabulary. */
  whyBaseline: readonly string[];
  rows: readonly ComparisonRow[];
  sources: readonly ComparisonSource[];
}

// Single source of truth. One entry today (the tracer); the surface grows by
// appending here. `as const` keeps slugs/locales literal for type-narrowing.
export const COMPARISONS = [
  {
    slug: "braintrust",
    competitor: "Braintrust",
    locales: ["en"],
    metaTitle: "Baseline vs Braintrust — LLM evaluation compared",
    metaDescription:
      "How Baseline and Braintrust compare for evaluating AI outputs: rubric-based scoring, scheduled eval runs, and automated prompt optimization. Verified, dated, and sourced.",
    heading: "Baseline vs Braintrust",
    intro:
      "Both Baseline and Braintrust help teams measure whether their AI is good enough to ship. The difference is what you do next: Baseline turns each evaluation into a Rubric you can re-run on a Schedule and hand to an Optimization Run that improves the prompts for you — so quality keeps climbing without an engineer babysitting it.",
    asOf: "2026-06-21",
    whyBaseline: [
      "Score AI outputs against a Rubric your whole team can read — no notebook required.",
      "Put quality on autopilot: a Schedule re-runs your evaluations and flags regressions before customers do.",
      "Let an Optimization Run rewrite weak prompts for you, then prove the lift against the same Rubric.",
    ],
    rows: [
      {
        dimension: "Rubric-based scoring of AI outputs",
        baseline:
          "Weighted criteria authored in the UI; every Eval Run returns one overall score the whole Team can read.",
        competitor:
          "Supports custom scorers and LLM-as-judge evaluations defined in code.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Scheduled, recurring evaluations",
        baseline:
          "A Schedule re-runs a Rubric on a cadence against a connected System and surfaces regressions automatically.",
        competitor:
          "Evaluations are run from the SDK or CI; recurring runs are wired up by the user.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Automated prompt optimization",
        baseline:
          "An Optimization Run searches for better prompts and proves the lift against the same Rubric.",
        competitor:
          "Offers prompt playground and experiment tracking; prompt search is user-driven.",
        sourceId: "bt-docs",
      },
      {
        dimension: "Who it's built for",
        baseline:
          "Non-technical and technical teammates share one workspace; Readonly Members can view results without editing.",
        competitor:
          "Developer-first platform centered on the SDK and code-defined evals.",
        sourceId: "bt-home",
      },
      {
        dimension: "Getting started",
        baseline: "Free tier with no credit card; create a Rubric in the browser.",
        competitor: "Free tier available; see Braintrust pricing for current limits.",
        sourceId: "bt-pricing",
      },
    ],
    sources: [
      { id: "bt-home", label: "Braintrust", url: "https://www.braintrust.dev/" },
      {
        id: "bt-docs",
        label: "Braintrust documentation",
        url: "https://www.braintrust.dev/docs",
      },
      {
        id: "bt-pricing",
        label: "Braintrust pricing",
        url: "https://www.braintrust.dev/pricing",
      },
    ],
  },
] as const satisfies readonly Comparison[];

/** Look up a comparison by its URL slug. */
export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
