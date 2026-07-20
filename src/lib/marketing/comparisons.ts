import { defaultLocale, type AppLocale } from "@/i18n/routing";
import { COMPARISONS_ES } from "./comparisons.es";
import { COMPARISONS_FR } from "./comparisons.fr";

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
   * The set of locales this page actually exists in (ADR-0013). Now `["en","es","fr"]`
   * for every page: the es/fr translations landed in #280, so each locale is served,
   * self-canonicals, and emits the full `hreflang` cluster. Must stay in lockstep with
   * the translations in `comparisons.es.ts`/`comparisons.fr.ts` — a locale listed here
   * without a matching translation is the broken-`hreflang` state ADR-0013 exists to
   * prevent (pinned by the translation-completeness test).
   */
  locales: readonly AppLocale[];
  /**
   * ISO date the page's copy last materially changed, emitted as the sitemap
   * entry's `lastmod` (the one recrawl hint Google actually reads). Bump it
   * alongside any real content edit; never stamp a build timestamp here.
   */
  updatedAt: string;
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
    locales: ["en", "es", "fr"],
    updatedAt: "2026-06-21",
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
  {
    slug: "langsmith",
    competitor: "LangSmith",
    locales: ["en", "es", "fr"],
    updatedAt: "2026-06-21",
    metaTitle: "Baseline vs LangSmith — LLM evaluation compared",
    metaDescription:
      "How Baseline and LangSmith compare for evaluating AI outputs: rubric-based scoring, scheduled eval runs, and automated prompt optimization. Verified, dated, and sourced.",
    heading: "Baseline vs LangSmith",
    intro:
      "LangSmith and Baseline both help teams measure whether their AI is good enough to ship. The difference is what happens after the score: Baseline turns each evaluation into a Rubric you re-run on a Schedule and hand to an Optimization Run that improves the prompts for you — so quality keeps climbing without an engineer in the loop.",
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
          "Provides evaluators and LLM-as-judge scoring configured via the SDK or UI.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Scheduled, recurring evaluations",
        baseline:
          "A Schedule re-runs a Rubric on a cadence against a connected System and surfaces regressions automatically.",
        competitor:
          "Evaluates logged traces and datasets from the SDK or CI; recurring runs are wired up by the user.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Automated prompt optimization",
        baseline:
          "An Optimization Run searches for better prompts and proves the lift against the same Rubric.",
        competitor:
          "Centers on tracing, datasets, and experiments; prompt iteration is user-driven.",
        sourceId: "ls-docs",
      },
      {
        dimension: "Who it's built for",
        baseline:
          "Non-technical and technical teammates share one workspace; Readonly Members can view results without editing.",
        competitor:
          "Developer-focused, tightly integrated with the LangChain ecosystem.",
        sourceId: "ls-home",
      },
      {
        dimension: "Getting started",
        baseline: "Free tier with no credit card; create a Rubric in the browser.",
        competitor: "Free tier available; see LangSmith pricing for current limits.",
        sourceId: "ls-pricing",
      },
    ],
    sources: [
      {
        id: "ls-home",
        label: "LangSmith",
        url: "https://www.langchain.com/langsmith",
      },
      {
        id: "ls-docs",
        label: "LangSmith documentation",
        url: "https://docs.smith.langchain.com/",
      },
      {
        id: "ls-pricing",
        label: "LangSmith pricing",
        url: "https://www.langchain.com/pricing",
      },
    ],
  },
  {
    slug: "humanloop",
    competitor: "Humanloop",
    locales: ["en", "es", "fr"],
    updatedAt: "2026-06-21",
    metaTitle: "Baseline vs Humanloop — LLM evaluation compared",
    metaDescription:
      "How Baseline and Humanloop compare for evaluating AI outputs: rubric-based scoring, scheduled eval runs, and automated prompt optimization. Verified, dated, and sourced.",
    heading: "Baseline vs Humanloop",
    intro:
      "Humanloop and Baseline both help teams judge and improve their AI. The difference is the loop: Baseline turns each evaluation into a Rubric you re-run on a Schedule and hand to an Optimization Run that rewrites the prompts for you — so improvement is automatic, not another task on someone's plate.",
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
          "Provides evaluators including human and LLM-as-judge, managed in its UI.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Scheduled, recurring evaluations",
        baseline:
          "A Schedule re-runs a Rubric on a cadence against a connected System and surfaces regressions automatically.",
        competitor:
          "Runs evaluations from the SDK or CI; recurring runs are wired up by the user.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Automated prompt optimization",
        baseline:
          "An Optimization Run searches for better prompts and proves the lift against the same Rubric.",
        competitor:
          "Focuses on prompt management and versioning; prompt changes are author-driven.",
        sourceId: "hl-docs",
      },
      {
        dimension: "Who it's built for",
        baseline:
          "Non-technical and technical teammates share one workspace; Readonly Members can view results without editing.",
        competitor:
          "Aimed at product and engineering teams collaborating on prompts.",
        sourceId: "hl-home",
      },
      {
        dimension: "Getting started",
        baseline: "Free tier with no credit card; create a Rubric in the browser.",
        competitor: "See Humanloop pricing for current plans and trial details.",
        sourceId: "hl-pricing",
      },
    ],
    sources: [
      { id: "hl-home", label: "Humanloop", url: "https://humanloop.com/" },
      {
        id: "hl-docs",
        label: "Humanloop documentation",
        url: "https://humanloop.com/docs",
      },
      {
        id: "hl-pricing",
        label: "Humanloop pricing",
        url: "https://humanloop.com/pricing",
      },
    ],
  },
  {
    slug: "langfuse",
    competitor: "Langfuse",
    locales: ["en", "es", "fr"],
    updatedAt: "2026-06-21",
    metaTitle: "Baseline vs Langfuse — LLM evaluation compared",
    metaDescription:
      "How Baseline and Langfuse compare for evaluating AI outputs: rubric-based scoring, scheduled eval runs, and automated prompt optimization. Verified, dated, and sourced.",
    heading: "Baseline vs Langfuse",
    intro:
      "Langfuse and Baseline both help teams measure AI quality. The difference is what you do with the result: Baseline turns each evaluation into a Rubric you re-run on a Schedule and hand to an Optimization Run that improves the prompts for you — so quality keeps climbing without an engineer babysitting it.",
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
          "Records LLM-as-judge and custom scores against traces, configured by the user.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Scheduled, recurring evaluations",
        baseline:
          "A Schedule re-runs a Rubric on a cadence against a connected System and surfaces regressions automatically.",
        competitor:
          "Supports evaluations on traces and datasets; cadence is configured by the user.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Automated prompt optimization",
        baseline:
          "An Optimization Run searches for better prompts and proves the lift against the same Rubric.",
        competitor:
          "Centers on tracing, datasets, and experiments; prompt iteration is user-driven.",
        sourceId: "lf-docs",
      },
      {
        dimension: "Who it's built for",
        baseline:
          "Non-technical and technical teammates share one workspace; Readonly Members can view results without editing.",
        competitor:
          "Developer-focused and open-source, with self-hosting available.",
        sourceId: "lf-home",
      },
      {
        dimension: "Getting started",
        baseline: "Free tier with no credit card; create a Rubric in the browser.",
        competitor:
          "Open-source with a free cloud tier; see Langfuse pricing for current limits.",
        sourceId: "lf-pricing",
      },
    ],
    sources: [
      { id: "lf-home", label: "Langfuse", url: "https://langfuse.com/" },
      {
        id: "lf-docs",
        label: "Langfuse documentation",
        url: "https://langfuse.com/docs",
      },
      {
        id: "lf-pricing",
        label: "Langfuse pricing",
        url: "https://langfuse.com/pricing",
      },
    ],
  },
  {
    slug: "arize",
    competitor: "Arize AI",
    locales: ["en", "es", "fr"],
    updatedAt: "2026-07-20",
    metaTitle: "Baseline vs Arize AI: LLM evaluation compared",
    metaDescription:
      "How Baseline and Arize AI compare for evaluating AI outputs: rubric-based scoring, scheduled eval runs, and automated prompt optimization. Verified, dated, and sourced.",
    heading: "Baseline vs Arize AI",
    intro:
      "Arize AI and Baseline both help teams tell whether their AI is good enough to ship. The difference is what happens after the score: Arize centers on tracing and observability for engineers, while Baseline turns each evaluation into a Rubric you re-run on a Schedule and hand to an Optimization Run that improves the prompts for you, so quality keeps climbing without an engineer babysitting it.",
    asOf: "2026-07-20",
    whyBaseline: [
      "Score AI outputs against a Rubric your whole team can read, no notebook required.",
      "Put quality on autopilot: a Schedule re-runs your evaluations and flags regressions before customers do.",
      "Let an Optimization Run rewrite weak prompts for you, then prove the lift against the same Rubric.",
    ],
    rows: [
      {
        dimension: "Rubric-based scoring of AI outputs",
        baseline:
          "Weighted criteria authored in the UI; every Eval Run returns one overall score the whole Team can read.",
        competitor:
          "Provides LLM-as-judge evaluations (relevance, toxicity, and quality) configured through Phoenix or the SDK.",
        sourceId: "az-docs",
      },
      {
        dimension: "Scheduled, recurring evaluations",
        baseline:
          "A Schedule re-runs a Rubric on a cadence against a connected System and surfaces regressions automatically.",
        competitor:
          "Evaluates traces and datasets from the SDK or UI; recurring runs are wired up by the user.",
        sourceId: "az-docs",
      },
      {
        dimension: "Automated prompt optimization",
        baseline:
          "An Optimization Run searches for better prompts and proves the lift against the same Rubric.",
        competitor:
          "Offers a prompt playground and prompt management with versioning; prompt changes are user-driven.",
        sourceId: "az-docs",
      },
      {
        dimension: "Who it's built for",
        baseline:
          "Non-technical and technical teammates share one workspace; Readonly Members can view results without editing.",
        competitor:
          "Developer- and ML-engineer-focused, centered on OpenTelemetry tracing and observability.",
        sourceId: "az-home",
      },
      {
        dimension: "Getting started",
        baseline: "Free tier with no credit card; create a Rubric in the browser.",
        competitor:
          "Open-source Phoenix plus a free managed tier; see Arize pricing for current limits.",
        sourceId: "az-pricing",
      },
    ],
    sources: [
      { id: "az-home", label: "Arize AI", url: "https://arize.com/" },
      {
        id: "az-docs",
        label: "Arize documentation",
        url: "https://arize.com/docs/",
      },
      {
        id: "az-pricing",
        label: "Arize pricing",
        url: "https://arize.com/pricing/",
      },
    ],
  },
] as const satisfies readonly Comparison[];

/**
 * The translatable subset of a comparison (#280). `slug`, `competitor` (proper
 * noun), `locales`, `asOf`, and `sources` (ids/URLs, and citation labels we leave
 * in English) are structural and stay; everything else is rendered prose. Rows
 * keep their `sourceId` so a translated row still resolves to a cited source — the
 * `Required<…>`-style shape makes a half-done translation a compile error.
 */
export type ComparisonTranslation = Pick<
  Comparison,
  "metaTitle" | "metaDescription" | "heading" | "intro" | "whyBaseline" | "rows"
>;

// Per-locale translations, keyed by slug (#280). `en` is the canonical data above;
// `es`/`fr` overlay their prose at lookup time. Kept in separate files so a native
// reviewer reads one language top to bottom.
const TRANSLATIONS: Partial<
  Record<AppLocale, Record<string, ComparisonTranslation>>
> = {
  es: COMPARISONS_ES,
  fr: COMPARISONS_FR,
};

/**
 * Look up a comparison by slug, resolved into `locale`. The default locale returns
 * the canonical English entry; any other locale overlays its translation. A
 * non-default locale with no translation returns English unchanged — but the
 * route's locale-set guard never serves that case, because `locales` is only
 * widened once the translation lands (pinned by the completeness test).
 */
export function getComparison(
  slug: string,
  locale: AppLocale = defaultLocale
): Comparison | undefined {
  const base = COMPARISONS.find((c) => c.slug === slug);
  if (!base || locale === defaultLocale) return base;
  const translation = TRANSLATIONS[locale]?.[slug];
  return translation ? { ...base, ...translation } : base;
}
