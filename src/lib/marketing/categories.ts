import { defaultLocale, type AppLocale } from "@/i18n/routing";
import { CATEGORIES_ES } from "./categories.es";
import { CATEGORIES_FR } from "./categories.fr";

/**
 * The category landing surface (ADR-0013), as a single typed data file. Each entry
 * drives one top-level `/{slug}` page end-to-end: routing, metadata, the rendered
 * prose template, the dynamic OG image, and the sitemap. These are prose-led
 * explainer pages (not the competitor matrix the `/compare/*` tracer renders), each
 * targeting one head term.
 *
 * Editorial rules (from the SEO plan, enforced at review):
 * - Audience is the non-technical buyer: outcome/ROI-led, plain language, glossary
 *   vocabulary (Rubric, Eval Run, Schedule, Optimization Run) over jargon.
 * - Each page owns a genuinely distinct `angle` so the four don't cannibalize one
 *   another or read as doorway pages. The angles are asserted unique in tests and
 *   are the reviewer's anti-overlap checklist.
 * - Claims describe Baseline honestly: every "how Baseline does it" point maps to a
 *   primitive that actually exists, never an aspiration.
 */

/** A product primitive mapped to the category concept, in glossary vocabulary. */
export interface CategoryFeature {
  /** The product primitive or capability, e.g. "Rubrics". */
  feature: string;
  /** How it delivers the concept, in plain language. */
  body: string;
}

/** A buyer-facing question/answer pair. */
export interface CategoryFaq {
  question: string;
  answer: string;
}

/** One step in a "how to get started" walkthrough, in plain action language. */
export interface CategoryStep {
  /** Short imperative title, e.g. "Create a Rubric". */
  title: string;
  /** One or two sentences on what to do and where to find it in Baseline. */
  description: string;
  /**
   * Optional deep link to the relevant product section for this step (e.g. "/rubrics").
   * Renders as a "Go to …" link on the step so readers can act immediately.
   */
  href?: string;
  /**
   * Optional contextual tip — a short sentence or two about what to watch for,
   * a common mistake, or what success looks like at this step. Renders as a
   * subtle callout below the description so the step stays scannable.
   */
  tip?: string;
  /**
   * Optional concrete code or data example (plain text, rendered in a monospace
   * block). Use for CSV/JSON format samples, command snippets, or any example a
   * user can copy and adapt. Renders below the tip as a scrollable pre/code block.
   */
  codeExample?: string;
  /**
   * Optional "what you'll see after this step" note. Grounds the action in a
   * concrete UI outcome so users can verify they did the step correctly. Renders
   * as a subtle success-tinted callout below the tip/code example with a
   * "You'll see:" prefix.
   */
  expectedResult?: string;
}

/** A problem/solution pair for the troubleshooting section of a guide. */
export interface CategoryTroubleshooting {
  /** Short description of the problem, e.g. "My score is lower than I expected". */
  problem: string;
  /** What to do about it — one or two sentences of concrete, actionable guidance. */
  solution: string;
  /**
   * Optional deep link to the product section where the user can act on this fix
   * (e.g. "/rubrics" to open the Rubric editor, "/schedules" to inspect a failing
   * Schedule). Renders as a "Go to …" link on the troubleshooting card.
   */
  href?: string;
}

export interface Category {
  /** Flat top-level URL slug: `/{slug}` (a head term). */
  slug: string;
  /**
   * The set of locales this page actually exists in (ADR-0013). Now `["en","es","fr"]`
   * for every page: the es/fr translations landed in #280, so each locale is served,
   * self-canonicals, and emits the full `hreflang` cluster. This must stay in lockstep
   * with the translations in `categories.es.ts`/`categories.fr.ts` — a locale listed
   * here without a matching translation is the broken-`hreflang` state ADR-0013 exists
   * to prevent (pinned by the translation-completeness test).
   */
  locales: readonly AppLocale[];
  /** `<title>` and OG/Twitter title. */
  metaTitle: string;
  metaDescription: string;
  /** On-page H1. */
  heading: string;
  /**
   * One-line positioning that makes this page's angle distinct from its siblings.
   * Asserted unique in tests; the reviewer's anti-cannibalization check. Not
   * rendered on the page, it's an editorial guardrail.
   */
  angle: string;
  /** Subtitle rendered into the dynamic OG card under the page title. */
  ogSubtitle: string;
  /** Outcome/ROI-led intro paragraph for a non-technical buyer. */
  intro: string;
  /** Plain-language "what this is / why it matters" paragraphs. */
  explainer: readonly string[];
  /** How Baseline delivers the concept, mapped to real primitives. */
  howBaseline: readonly CategoryFeature[];
  /** Outcome bullets, what a team gets, in plain language. */
  outcomes: readonly string[];
  /** Buyer FAQs (also good for featured snippets). */
  faqs: readonly CategoryFaq[];
  /**
   * Optional step-by-step walkthrough showing how to actually use Baseline for this
   * use case. Kept optional so translations can omit it and fall back to the English
   * steps — the getCategory merge (`{ ...base, ...translation }`) preserves them.
   */
  steps?: readonly CategoryStep[];
  /**
   * Optional list of things a user needs before starting the step-by-step walkthrough.
   * Rendered as a "You'll need" callout above the numbered steps. Kept optional and
   * English-only for the same reason as `steps`.
   */
  stepsPrereq?: readonly string[];
  /**
   * Optional list of category slugs to surface as "Related guides" at the bottom of
   * the page. English-only (slugs are locale-independent); the route resolves each slug
   * to its heading for display. Kept optional so translations don't need to repeat it.
   */
  relatedSlugs?: readonly string[];
  /**
   * Optional human-readable estimate of how long it takes to complete the step-by-step
   * walkthrough, e.g. "~15 min". Rendered next to the steps heading so users can
   * judge the time commitment before starting. English-only; translations omit it and
   * fall back via the getCategory merge.
   */
  timeToComplete?: string;
  /**
   * Optional one-sentence goal statement for the step-by-step walkthrough, e.g.
   * "By the end, you'll have a live evaluation running against your AI on a schedule."
   * Renders as a lead paragraph below the heading before the prerequisites callout,
   * so users know what they're building toward before they start. English-only;
   * translations omit it and fall back via the getCategory merge.
   */
  stepsGoal?: string;
  /**
   * Optional troubleshooting entries for the guide — common problems and their fixes.
   * Rendered as a dedicated section after the steps so users know what to do when
   * something doesn't work as expected. English-only; translations omit it and fall
   * back via the getCategory merge.
   */
  troubleshooting?: readonly CategoryTroubleshooting[];
  /**
   * Optional practical guide FAQs — questions a user following the steps would ask
   * (CSV column names, file limits, timing, etc.), as opposed to the marketing/buyer
   * questions in `faqs`. Rendered in the same FAQ section after the main entries.
   * English-only; translations omit it and fall back via the getCategory merge.
   */
  guideFaqs?: readonly CategoryFaq[];
  /**
   * Optional difficulty level for the step-by-step walkthrough. Helps users
   * self-select the right guide to start with and sets expectations about scope.
   * English-only; translations omit it and fall back via the getCategory merge.
   */
  difficulty?: "Beginner" | "Intermediate" | "Advanced";
  /**
   * When true, this guide is the recommended entry point for users who are new to
   * Baseline. At most one guide should carry this flag. Renders a "Start here" badge
   * on the /docs index card. English-only; translations omit it and inherit via the
   * getCategory merge.
   */
  recommended?: boolean;
}

// Single source of truth. The surface grows by appending here (issue #279 adds the
// non-technical landers the same way). `as const` keeps slugs/locales literal.
export const CATEGORIES = [
  {
    slug: "llm-evaluation",
    locales: ["en", "es", "fr"],
    metaTitle: "LLM Evaluation: measure and improve AI quality | Baseline",
    metaDescription:
      "LLM evaluation is how teams check whether their AI is good enough to ship, and keep it that way. Baseline turns evaluation into rubrics, scheduled runs, and automated optimization, with no data-science team required.",
    heading: "LLM evaluation your whole team can actually run",
    angle:
      "The umbrella concept: what LLM evaluation is and how to operationalize it without a data-science team.",
    ogSubtitle: "Measure AI quality. Keep it climbing.",
    intro:
      "LLM evaluation is how you find out whether your AI is good enough to put in front of customers, before they tell you it isn't. Baseline makes that measurable and repeatable. You define what good looks like once, score every output against it, and let the system catch regressions and improve weak prompts on its own.",
    explainer: [
      "Large language models are non-deterministic. The same prompt can return a great answer today and a confusing one tomorrow. Without evaluation you're shipping on vibes: someone eyeballs a few outputs, calls it \"good enough,\" and quality drifts the moment a prompt, a model, or a vendor changes underneath you.",
      "LLM evaluation replaces the eyeball test with a measurement. You decide what a good output looks like, turn that into criteria, and score outputs against those criteria consistently. \"Is our AI working?\" stops being an opinion and becomes a number you can track over time and across releases.",
      "Done well, evaluation isn't a one-off audit. It runs continuously, flags regressions before customers hit them, and feeds directly into making the product better. That loop is exactly what Baseline is built around.",
    ],
    howBaseline: [
      {
        feature: "Rubrics",
        body: "Write down what a good output looks like as weighted criteria in plain language, with no notebook or eval framework to learn. Every Eval Run scores against that single shared definition.",
      },
      {
        feature: "Eval Runs",
        body: "Score a batch of AI outputs against a Rubric and get one overall number the whole team can read, plus the per-criterion breakdown that explains it.",
      },
      {
        feature: "Schedules",
        body: "Put evaluation on autopilot. A Schedule re-runs a Rubric against your live System on a cadence, so a regression shows up on a dashboard instead of in a support ticket.",
      },
      {
        feature: "Optimization Runs",
        body: "When quality dips, hand the Rubric to an Optimization Run that searches for better prompts and proves the lift against the same criteria.",
      },
    ],
    outcomes: [
      "Replace \"looks fine to me\" with a quality score your whole team trusts.",
      "Catch regressions automatically when a model, prompt, or vendor changes.",
      "Give non-technical teammates a way to judge AI quality without reading code.",
      "Turn every evaluation into a starting point for making the product better.",
    ],
    faqs: [
      {
        question: "Do I need a data-science team to evaluate an LLM?",
        answer:
          "No. Baseline is built so a product manager or domain expert can author a Rubric in the browser and read the results. Evaluation is a team activity, not a specialist one.",
      },
      {
        question: "How is this different from just testing prompts by hand?",
        answer:
          "Hand-testing checks a few outputs once and forgets. Evaluation scores every output against a fixed definition of quality, runs on a schedule, and tracks the trend, so you catch drift instead of rediscovering it.",
      },
      {
        question: "Can I start for free?",
        answer:
          "Yes. Baseline has a free tier with no credit card. Create a Rubric and run your first evaluation in the browser.",
      },
    ],
    steps: [
      {
        title: "Create a Rubric",
        description:
          "In the dashboard, open Rubrics and add a new one. Write the criteria that define a good output for your AI — accuracy, tone, completeness — and weight each one by how much it matters.",
        href: "/rubrics",
        tip: "Start with 3–5 criteria. Fewer, more meaningful criteria score more consistently than a long list — you can always add more once you see the results.",
        codeExample: `Criterion (40%): The answer is factually accurate — no fabricated names, numbers, or policies.\nCriterion (30%): The response directly addresses what the user asked, without unnecessary tangents.\nCriterion (30%): The answer is clear and easy to understand without domain expertise.`,
        expectedResult: "Your new Rubric appears in the Rubrics list. Open it to see the criteria and the Run eval button in the top right — that's where you'll kick off the Eval Run in step 3.",
      },
      {
        title: "Gather a batch of outputs to score",
        description:
          "Run your AI on 10–20 representative prompts and save the prompt + response pairs. You'll provide these directly to Baseline — as a CSV upload, JSON array, or manual entry — when you create the Eval Run.",
        tip: "Include edge cases you're worried about, not just prompts that usually go well. The Eval Run score is only as informative as the inputs you put in.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Open your Rubric and click Run eval. Choose your input source — manual entry, CSV upload, or JSON — and paste in the prompt + response pairs you collected. Baseline scores each row and returns an overall number plus a per-criterion breakdown.",
        href: "/rubrics",
        tip: "The CSV format is the easiest way to import a large batch. Each row needs a prompt (userInput) and your AI's response (agentOutput). Optional columns — expectedOutput and retrievalContext — improve scoring accuracy when present.",
        codeExample: `userInput,agentOutput,expectedOutput\n"What is the boiling point of water?","Water boils at 100 degrees.","100°C (212°F) at sea level"\n"How do I cancel my subscription?","Contact support at help@example.com.","Log in, go to Account > Billing, and click Cancel plan."`,
        expectedResult: "A results page with an overall score (0–100) and a per-criterion row for each output. Click any row to read the judge's reasoning for that specific score.",
      },
      {
        title: "Review the results",
        description:
          "Open the completed Eval Run to see the overall score and drill into any criterion that pulled it down. The breakdown explains exactly why each output scored the way it did.",
        href: "/dashboard",
        tip: "Look for one criterion that consistently drags the score down. That's the highest-leverage target — either update the prompt or tighten the criterion's wording.",
        expectedResult: "The Eval Run detail view shows your overall score at the top and a table of every scored output below. Clicking any row expands it to show the judge's per-criterion reasoning — this is where you identify which criterion consistently pulls the score down.",
      },
      {
        title: "Set up a Schedule",
        description:
          "In the Schedules wizard, connect your live agent endpoint and pick a cadence. Baseline will call your agent automatically, score the outputs against your Rubric, and surface regressions on the dashboard instead of in customer tickets.",
        href: "/schedules",
        tip: "Daily is a good starting cadence for active development. Weekly is enough once a product is stable. You can always adjust after seeing how often the score actually moves.",
        expectedResult: "Your Schedule appears in the Schedules list with the cadence, last run status, and next run time displayed. After its first run, you'll see a score trend line on the dashboard.",
      },
    ],
    stepsPrereq: [
      "A set of prompt + response pairs from your AI — 10 to 20 is a good starting batch",
      "Your agent's endpoint URL and auth credentials for when you set up the Schedule later",
      "A clear sense of what a good output looks like for your use case",
    ],
    relatedSlugs: ["rubric-based-evaluation", "prompt-optimization", "llm-as-judge"],
    timeToComplete: "~20 min",
    stepsGoal: "By the end, you'll have a scored Eval Run against your AI and a Schedule that automatically catches regressions as they happen.",
    difficulty: "Beginner",
    recommended: true,
    troubleshooting: [
      {
        problem: "My Eval Run score is much lower than I expected",
        solution: "Check the per-criterion breakdown to see which criteria are dragging the score down. Low scores often mean the criteria are stricter than the outputs can meet, or the test batch skews toward edge cases. Adjust the criteria weights first, not the outputs.",
        href: "/rubrics",
      },
      {
        problem: "I don't know what inputs to include in my first Eval Run",
        solution: "Start with 10–20 real examples — a mix of your strongest outputs, a few average ones, and at least one or two you already know are bad. A diverse batch reveals whether your Rubric is calibrated correctly far better than a batch of only good examples.",
        href: "/rubrics",
      },
      {
        problem: "My Schedule keeps failing",
        solution: "Use the test button inside the Schedule wizard to confirm Baseline can reach your agent endpoint. Most Schedule failures are network or auth errors, not scoring problems. Verify the endpoint URL and any auth headers before looking at the Rubric.",
        href: "/schedules",
      },
    ],
    guideFaqs: [
      {
        question: "What column names does the CSV need?",
        answer:
          "The required columns are userInput and agentOutput. You can optionally add expectedOutput (the correct answer) and retrievalContext (documents the AI used when generating the response). Baseline ignores any other columns.",
      },
      {
        question: "How many examples do I need for a meaningful score?",
        answer:
          "10–20 is enough to see patterns and calibrate your Rubric. Fewer than 5 gives noisy results that are hard to interpret. You can always add more examples later as you build confidence in what the score measures.",
      },
    ],
  },
  {
    slug: "llm-as-judge",
    locales: ["en", "es", "fr"],
    metaTitle: "LLM-as-a-Judge: automated scoring you can trust | Baseline",
    metaDescription:
      "LLM-as-a-judge uses one AI model to grade another's outputs at scale. Baseline makes that judgment consistent and readable, graded against a rubric your whole team agrees on instead of a black box.",
    heading: "LLM-as-a-judge, made consistent and reviewable",
    angle:
      "The scoring technique: how an LLM grades outputs, and how to make that judgment reliable instead of a black box.",
    ogSubtitle: "Automated grading you can actually trust.",
    intro:
      "LLM-as-a-judge is how you grade thousands of AI outputs without thousands of hours of human review. You ask a capable model to score the work against your criteria. The catch is trust, because an ungrounded grader is just another opinion. Baseline anchors the judge to a Rubric your team wrote, so the scores are consistent, explainable, and reviewable.",
    explainer: [
      "Human review is the gold standard for judging AI quality, and it doesn't scale. Reviewing every output by hand is slow, expensive, and inconsistent between reviewers, so most teams check a tiny sample and hope it's representative.",
      "LLM-as-a-judge closes that gap. A strong model reads each output and scores it against your criteria, the same way a trained reviewer would, but in seconds and at any volume. The risk is that an unconstrained judge is opaque: you get a number with no idea why, and no two runs agree.",
      "The fix is grounding. When the judge scores against an explicit, weighted rubric instead of a vague \"is this good?\", its judgments become consistent and auditable. You can see which criterion drove a low score and check the call yourself. That's the difference between a useful grader and a black box.",
    ],
    howBaseline: [
      {
        feature: "Rubric-anchored judging",
        body: "The judge scores against the same weighted criteria your team authored, not an invisible internal standard, so every score traces back to a criterion you can read.",
      },
      {
        feature: "Per-criterion breakdown",
        body: "Each Eval Run shows how the judge scored every criterion, so a low overall number comes with the reason. No guessing why an output failed.",
      },
      {
        feature: "Consistent re-runs",
        body: "Because the rubric is fixed, the same outputs grade the same way across runs. You're measuring the AI, not the mood of the grader.",
      },
      {
        feature: "Human in the loop",
        body: "Spot-check the judge's calls and keep the rubric honest. The automated score handles the volume, and your team keeps the final say.",
      },
    ],
    outcomes: [
      "Grade thousands of outputs without thousands of hours of review.",
      "Get scores that come with reasons, not just a number.",
      "Keep grading consistent run-to-run because the criteria don't move.",
      "Audit and override the judge whenever you need to.",
    ],
    faqs: [
      {
        question: "Can you really trust an LLM to grade another LLM?",
        answer:
          "You can when the judge is anchored to an explicit rubric and its per-criterion reasoning is visible for review. Baseline is built around that grounding, and you can always spot-check or override a call.",
      },
      {
        question: "Won't the scores be different every time?",
        answer:
          "Drift comes from vague instructions. Scoring against fixed, weighted criteria makes runs comparable, so a score change reflects the AI changing, not the grader.",
      },
      {
        question: "Is LLM-as-a-judge a replacement for human review?",
        answer:
          "It's a force multiplier. The judge handles the volume, while your team sets the criteria and keeps the final say on the calls that matter.",
      },
    ],
    steps: [
      {
        title: "Write a grounding Rubric",
        description:
          "Create a Rubric with weighted criteria that define what a good output looks like. The more specific your criteria, the more consistent and trustworthy the judge's scores will be.",
        href: "/rubrics",
        tip: "Vague criteria like 'is helpful' produce inconsistent scores. Replace them with observable signals: 'The answer directly addresses the question asked' is something the judge can reliably check.",
        codeExample: `Criterion (50%): The answer correctly and completely addresses the specific question asked.\nCriterion (30%): The response contains no fabricated claims, numbers, or citations.\nCriterion (20%): The explanation is clear and free of confusing jargon.`,
        expectedResult: "Your Rubric appears in the Rubrics list. Click it to open the detail view — you'll use the Run eval button here in step 3 to give the judge its first batch of outputs to score.",
      },
      {
        title: "Collect outputs for the judge to score",
        description:
          "Run your AI on a representative set of prompts and save the prompt + response pairs. Eval Runs score outputs you provide — upload a CSV or paste them in manually. The judge needs the actual text, not a live connection.",
        tip: "A mix of strong outputs, borderline ones, and known failures gives you the most useful first-run signal. If every output scores high, your criteria may be too easy to pass.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Open your Rubric and click Run eval. Provide the prompt + response pairs you collected — the judge scores each output against your criteria and returns an overall number and the per-criterion reasoning behind each score.",
        href: "/rubrics",
        tip: "Your first run is calibration as much as measurement. The overall score matters less than seeing whether the per-criterion reasoning matches your judgment.",
        codeExample: `userInput,agentOutput\n"Summarize the Q3 earnings call.","Revenue grew 12% YoY driven by enterprise subscriptions. Operating margin improved to 18%."\n"What is our refund policy?","We offer a 30-day money-back guarantee on all plans."`,
        expectedResult: "An overall score plus the judge's reasoning for each criterion on every output row. This is the raw signal for calibrating whether the Rubric is grounding the judge correctly.",
      },
      {
        title: "Review the reasoning",
        description:
          "Drill into individual outputs to see which criterion drove a low score. Spot-check any call that surprises you — the reasoning is visible, not a black box.",
        href: "/rubrics",
        tip: "If the judge's reasoning surprises you, that's a signal to sharpen the criterion — not a sign the judge is broken. Unexpected calls usually mean the criterion left room for interpretation.",
        expectedResult: "Each scored row expands to show the judge's per-criterion explanation — the specific reasoning behind why a criterion passed or failed for that exact output.",
      },
      {
        title: "Refine the Rubric",
        description:
          "If the judge's reasoning doesn't match your expectation, edit the criterion that's off. One change in the Rubric updates every future run automatically.",
        href: "/rubrics",
        tip: "Run the same batch again after editing a criterion to confirm the scores moved in the direction you expected. Two or three calibration rounds is normal before the judge feels reliable.",
        expectedResult: "After saving the updated criterion, re-run your Eval Run on the same batch of outputs from step 3. Look for the criterion you changed to show a shifted distribution — higher scores if you loosened it, lower if you tightened. That shift confirms the criterion is grounding the judge as intended.",
      },
    ],
    stepsPrereq: [
      "A set of prompt + response pairs from your AI — the outputs the judge will score",
      "A clear definition of what a good output looks like (you'll turn this into Rubric criteria)",
    ],
    relatedSlugs: ["llm-evaluation", "rubric-based-evaluation"],
    timeToComplete: "~15 min",
    stepsGoal: "By the end, you'll have a calibrated rubric-anchored judge that scores your AI outputs consistently, and you'll know how to read and refine its reasoning.",
    difficulty: "Beginner",
    troubleshooting: [
      {
        problem: "The judge scores everything high — nothing fails",
        solution: "Your criteria may be too broad or too lenient. Add a 'critical failure' criterion that zeros out when the output contains a factual error or hallucination. Then include at least one known-bad output in your batch to confirm the criterion actually fires.",
        href: "/rubrics",
      },
      {
        problem: "Scores vary a lot between runs on the same outputs",
        solution: "Vague criteria produce inconsistent scores because the judge interprets them differently each time. Replace subjective labels like 'helpful' with observable signals: 'The response directly answers the question asked' is something the judge can check reliably run-to-run.",
        href: "/rubrics",
      },
      {
        problem: "The judge flags an output I think is fine",
        solution: "Read the per-criterion reasoning for that output in the Eval Run details. If the criterion left room for interpretation, the judge took a different one than you intended. Edit the criterion to be more specific, then re-run the same batch to confirm it corrects.",
        href: "/rubrics",
      },
    ],
    guideFaqs: [
      {
        question: "How many criteria should my Rubric have?",
        answer:
          "3–5 is a good starting point. More criteria aren't always better — they make the score harder to interpret and the judge less consistent across runs. Add more only after you've seen what the initial criteria miss.",
      },
      {
        question: "What if the judge gives very different scores when I re-run the same batch?",
        answer:
          "Rerunning on the same outputs and Rubric should give nearly identical results. Large swings usually mean a criterion is written ambiguously — try adding an observable, checkable signal to replace vague labels like 'helpful' or 'clear'.",
      },
    ],
  },
  {
    slug: "prompt-optimization",
    locales: ["en", "es", "fr"],
    metaTitle: "Prompt Optimization: stop hand-tuning prompts | Baseline",
    metaDescription:
      "Prompt optimization means systematically finding prompts that score higher, instead of tweaking by hand and hoping. Baseline runs the search for you and proves the lift against your rubric.",
    heading: "Prompt optimization without the guesswork",
    angle:
      "The improvement loop: automatically searching for better prompts and proving the lift, instead of hand-tuning.",
    ogSubtitle: "Better prompts, found and proven for you.",
    intro:
      "Prompt optimization is how you get a meaningfully better prompt without spending a week tweaking wording and hoping. Baseline treats it as a search. It generates and tests prompt variations, scores each against your Rubric, and hands back the version that measurably wins, with the proof attached.",
    explainer: [
      "Most teams improve prompts by hand: change a sentence, run a few examples, decide it feels better, ship it. It's slow, it doesn't scale past a couple of prompts, and \"feels better\" is exactly the unmeasured judgment evaluation exists to replace.",
      "Prompt optimization makes the improvement systematic. The system explores many candidate prompts, scores each against the same criteria, and keeps what actually performs. It turns prompt engineering from one person's guesswork into a measured search.",
      "A better score is worth more when you can defend it. When a new prompt beats the rubric your team agreed on, you can ship it knowing the gain is real and show that number to anyone who asks.",
    ],
    howBaseline: [
      {
        feature: "Optimization Runs",
        body: "Point a run at the prompt you want to improve, and it searches for stronger variations automatically instead of you editing and re-testing by hand.",
      },
      {
        feature: "Scored against your Rubric",
        body: "Every candidate is graded against the same criteria you evaluate with, so a winner is one that beats your real definition of quality, not a different benchmark.",
      },
      {
        feature: "Proven lift",
        body: "The run reports the before-and-after score against that Rubric, so the improvement is a number you can show, not a hunch.",
      },
      {
        feature: "Closes the loop",
        body: "The same Rubric that caught the regression drives the fix. Evaluation and improvement are one workflow, not two disconnected tools.",
      },
    ],
    outcomes: [
      "Stop spending engineering time hand-tuning prompts.",
      "Improve prompts your non-technical experts can't edit but can evaluate.",
      "Ship prompt changes with proof of the gain, not a gut feeling.",
      "Turn a failed evaluation straight into a better prompt.",
    ],
    faqs: [
      {
        question: "How is this different from a prompt playground?",
        answer:
          "A playground lets you try prompts one at a time and judge by eye. Optimization searches many candidates for you and scores each against your rubric, so the winner is measured, not chosen on a hunch.",
      },
      {
        question: "Do I have to trust the new prompt blindly?",
        answer:
          "No. Every Optimization Run reports the before-and-after score against the same Rubric you evaluate with, so you ship the change knowing exactly how much it helped.",
      },
      {
        question: "Who can run an optimization?",
        answer:
          "Anyone who can read results. The expert who owns the Rubric kicks off a run and reviews the proven lift, with no prompt-engineering background required.",
      },
    ],
    steps: [
      {
        title: "Run a baseline Eval Run",
        description:
          "Before optimizing, score your current prompt against your Rubric to get a baseline number. Open your Rubric and click Run eval, then provide prompt + response pairs by CSV, JSON, or manual entry. This is the score the optimization will try to beat.",
        href: "/rubrics",
        tip: "Use the same set of test inputs for both the baseline Eval Run and the confirmation run at the end. Comparing against a different batch makes the lift hard to interpret.",
        codeExample: `userInput,agentOutput\n"What is the return policy?","You can return any item within 30 days of purchase for a full refund."\n"How do I upgrade my plan?","Go to Account > Billing and click Upgrade. Changes take effect immediately."`,
        expectedResult: "An Eval Run results page showing your current baseline score (0–100). Note this number — it's the target the Optimization Run will try to beat in step 2.",
      },
      {
        title: "Start an Optimization Run",
        description:
          "Open Optimization Runs and click New. Select your Rubric, then choose how to provide your System: paste a prompt directly to run it on Baseline's managed LLM, or connect your own agent endpoint. Baseline generates and tests candidate prompts automatically.",
        href: "/optimizations",
        tip: "The optimization works by varying your prompt systematically, so the clearer and more specific your Rubric, the more targeted the candidates it produces.",
        expectedResult: "The run opens to a progress view as candidates are generated and scored. Most runs produce 5–10 candidates and complete within a few minutes.",
      },
      {
        title: "Review the ranked candidates",
        description:
          "The run returns the top candidate prompts ranked by score, each with a before-and-after comparison against the same Rubric.",
        href: "/optimizations",
        tip: "Read the candidate prompts, not just the scores. A candidate that wins on your Rubric but reads oddly or contradicts your brand may score well but ship badly.",
        expectedResult: "A ranked table of candidate prompts. Each row shows the candidate text, its score, and the delta versus your baseline — highest score at the top.",
      },
      {
        title: "Pick the winner",
        description:
          "Choose the prompt that measurably beats your baseline. The improvement is a number against your own criteria, not a gut feeling.",
        href: "/optimizations",
        expectedResult: "The winning candidate prompt is shown in full alongside its score and its delta versus your baseline. Use the copy button to grab the text and paste it into your AI.",
      },
      {
        title: "Confirm the lift",
        description:
          "Copy the winning prompt into your AI and run a follow-up Eval Run to confirm the gain holds in production.",
        href: "/rubrics",
        tip: "A small gap between the optimization score and the confirmation score is normal — they ran at different times. A large gap may mean the winning prompt overfits the test set.",
        expectedResult: "A second Eval Run results page. If the score is within a few points of the Optimization Run's reported gain, the lift is real. A significantly lower score usually means the winning prompt overfit the small test set.",
      },
    ],
    stepsPrereq: [
      "A Rubric with criteria that define what a good output looks like (create one in Rubrics first if you don't have one)",
      "The current prompt you want to beat — this becomes your baseline score",
      "Your agent's endpoint URL if you want to optimize against a live agent, or just the prompt text to use Baseline's managed LLM",
    ],
    relatedSlugs: ["llm-evaluation", "rubric-based-evaluation"],
    timeToComplete: "~30 min",
    stepsGoal: "By the end, you'll have a winning prompt that measurably beats your baseline score, with the before-and-after proof attached.",
    difficulty: "Advanced",
    troubleshooting: [
      {
        problem: "The optimization doesn't improve my score",
        solution: "If all Rubric criteria score between 0.7 and 0.9, the optimizer has no gradient to improve against. Add a stretch criterion that only the best outputs achieve, or verify that your baseline Eval Run uses the exact same test inputs the optimization will score.",
        href: "/optimizations",
      },
      {
        problem: "The winning prompt reads oddly or doesn't match my brand",
        solution: "Add a criterion to your Rubric that rewards on-brand, natural-sounding responses. The optimizer only improves what your Rubric measures — if brand voice isn't a criterion, it won't be preserved when the system searches for candidates.",
        href: "/rubrics",
      },
      {
        problem: "The confirmation Eval Run shows a much smaller gain than the optimization reported",
        solution: "A small gap is normal — the runs happened at different times with slight model variance. A large gap usually means the winning prompt overfit the small test set. Try running the optimization with more test inputs to reduce overfitting.",
        href: "/rubrics",
      },
    ],
    guideFaqs: [
      {
        question: "How long does an Optimization Run take?",
        answer:
          "Most runs complete in a few minutes. Longer runs happen when you have many test inputs or a slow agent endpoint. The UI shows progress as candidates are scored, so you can watch it work.",
      },
      {
        question: "Can I optimize a prompt I didn't write?",
        answer:
          "Yes. Paste the existing prompt as your starting point and Baseline searches for variations that beat it against your Rubric. You don't need to understand the prompt's structure — the Rubric does the evaluation.",
      },
    ],
  },
  {
    slug: "rubric-based-evaluation",
    locales: ["en", "es", "fr"],
    metaTitle: "Rubric-Based Evaluation: define quality once | Baseline",
    metaDescription:
      "Rubric-based evaluation turns a fuzzy sense of \"good output\" into explicit, weighted criteria your whole team agrees on. Baseline makes the rubric the shared, reusable definition every eval and optimization runs against.",
    heading: "Rubric-based evaluation: one definition of good",
    angle:
      "The criteria artifact: turning a fuzzy sense of quality into explicit, weighted, shareable criteria the whole team owns.",
    ogSubtitle: "Define good once. Reuse it everywhere.",
    intro:
      "Rubric-based evaluation is how you make \"good output\" mean the same thing to everyone, so quality stops living in each reviewer's head. You write it down once as weighted criteria, and that Rubric becomes the single definition every Eval Run, Schedule, and Optimization Run measures against.",
    explainer: [
      "Ask three people whether an AI answer is \"good\" and you'll get three answers. One cares about accuracy, one about tone, one about length. That disagreement stays invisible until it ships as inconsistent quality, and it's why scores nobody defined are scores nobody trusts.",
      "A rubric makes the standard explicit. You break \"good\" into named criteria and weight them by what actually matters to your product. Now everyone, and every automated grader, scores against the same thing. The fuzzy judgment becomes a shared, written artifact your team owns.",
      "Because the rubric is one reusable object, it ties the whole workflow together. The same criteria that define a passing Eval Run drive the scheduled checks and the optimization that fixes regressions. Change the definition of good in one place and everything downstream follows.",
    ],
    howBaseline: [
      {
        feature: "Weighted criteria",
        body: "Author the criteria that define a good output and weight them by importance, so the overall score reflects what actually matters to your product.",
      },
      {
        feature: "Authored in the UI",
        body: "Build and edit Rubrics in the browser in plain language. The domain expert who knows what good looks like owns the definition, with no code required.",
      },
      {
        feature: "One shared definition",
        body: "The whole Team scores against the same Rubric, and Readonly Members can view results without changing the criteria, so the standard stays stable.",
      },
      {
        feature: "Reused across the workflow",
        body: "The same Rubric powers one-off Eval Runs, recurring Schedules, and Optimization Runs. Define quality once and reuse it everywhere.",
      },
    ],
    outcomes: [
      "Get every reviewer scoring against the same definition of good.",
      "Make quality an explicit, written artifact instead of tribal knowledge.",
      "Let domain experts own the criteria without touching code.",
      "Reuse one rubric across evaluation, monitoring, and optimization.",
    ],
    faqs: [
      {
        question: "What exactly is a rubric here?",
        answer:
          "A set of weighted criteria that define a good output, authored in plain language in the browser. It's the single, shared standard every evaluation, schedule, and optimization scores against.",
      },
      {
        question: "Who writes the rubric?",
        answer:
          "The person who knows what good looks like, usually a domain expert or product owner rather than an engineer. Baseline is built so they can author and edit it directly in the UI.",
      },
      {
        question: "Can I change the criteria later?",
        answer:
          "Yes. Edit the Rubric, and every Eval Run, Schedule, and Optimization Run that references it measures against the updated definition. One change, applied everywhere.",
      },
    ],
    steps: [
      {
        title: "Open Rubrics",
        description:
          "In the dashboard, go to Rubrics and create a new one. Give it a name that reflects what you're evaluating — a product, a use case, or a team standard.",
        href: "/rubrics",
        tip: "Name the Rubric after the thing it evaluates, not the person who made it. 'Support chat quality' ages better than 'Alice's rubric v2'.",
        expectedResult: "A new blank Rubric opens in edit mode. Give it a name and move to step 2 to add the criteria that define what a good output looks like.",
      },
      {
        title: "Add weighted criteria",
        description:
          "Add the criteria that define a good output and weight each one by importance. Accuracy might matter more than length, for example. Plain language only — no code required.",
        href: "/rubrics",
        tip: "Weights should reflect what actually matters to your product, not what's easiest to check. If accuracy is twice as important as tone, the scores should say so.",
        codeExample: `Criterion (40%): The answer correctly answers the question with accurate information.\nCriterion (35%): The response is relevant — it directly addresses what was asked.\nCriterion (25%): The tone and format match what a user in this context would expect.`,
        expectedResult: "The Rubric detail view shows the saved criteria and weights, summing to 100%. The Run eval button appears in the top right — click it when you're ready for step 3.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Open your Rubric and click Run eval. Provide prompt + response pairs by manual entry, CSV upload, or JSON. Baseline returns the overall score plus each criterion's individual contribution.",
        href: "/rubrics",
        tip: "The first run is as much a test of your Rubric as your AI. If a criterion scores everything the same way, it may be too broad to be useful — try narrowing it.",
        codeExample: `userInput,agentOutput\n"How do I reset my password?","Click 'Forgot password' on the login page and follow the email link."\n"What payment methods do you accept?","We accept Visa, Mastercard, and PayPal."`,
        expectedResult: "An overall score and a per-criterion breakdown. If a criterion scores all outputs the same (all high or all low), that's the Rubric telling you the criterion needs to be more specific.",
      },
      {
        title: "Share with your team",
        description:
          "Your Rubric is visible across the team. Team Members can run Eval Runs against it; Readonly Members can view results without being able to change the definition.",
        href: "/settings/team",
        tip: "Ask a colleague to read the criteria cold and predict how they'd score a borderline example. If they get a different answer than you expect, the criterion needs to be more specific.",
        expectedResult: "The Team Settings page shows all workspace members and their roles. Your Rubric is already accessible to all Team Members — there is no separate sharing step. Use this page to invite anyone who still needs workspace access.",
      },
      {
        title: "Set up a Schedule",
        description:
          "Open Schedules and create a new one. In the wizard, connect your live agent endpoint and set a cadence. Baseline will score your agent's outputs against this Rubric automatically on that schedule, so regressions show up on the dashboard instead of in support tickets.",
        href: "/schedules",
        tip: "The Schedule wizard creates the agent Connection inline — you do not need to configure it separately. Start with a daily cadence during active development; switch to weekly once the product is stable.",
        expectedResult: "Your Schedule appears in the Schedules list with its cadence and next run time. The Dashboard will show this Rubric's score as a trend line once the first automated run completes.",
      },
    ],
    stepsPrereq: [
      "A clear sense of what a good output looks like for your AI — you'll write this as criteria",
      "A set of prompt + response pairs from your AI to use in the first Eval Run",
      "Your agent's endpoint URL and auth credentials for when you set up a Schedule in step 5",
    ],
    relatedSlugs: ["llm-evaluation", "llm-as-judge", "prompt-optimization"],
    timeToComplete: "~15 min",
    stepsGoal: "By the end, you'll have a shared Rubric your whole team scores against and a live Schedule that automatically catches regressions.",
    difficulty: "Beginner",
    troubleshooting: [
      {
        problem: "Two of my criteria seem to be measuring the same thing",
        solution: "Overlap between criteria like 'clarity' and 'conciseness' is common. Consolidate them into a single criterion that covers both, or reduce the weight of the one that rarely changes the outcome. If two criteria give nearly identical scores across an Eval Run, they're probably duplicates.",
        href: "/rubrics",
      },
      {
        problem: "I changed my Rubric and now I can't compare new results to old ones",
        solution: "Rubric changes don't retroactively re-score old Eval Runs — each run is a snapshot against the Rubric version at the time. To compare across a Rubric change, run a new Eval Run on the same batch of outputs you used in the original run.",
        href: "/rubrics",
      },
      {
        problem: "My team disagrees about how to weight the criteria",
        solution: "Run an Eval Run with the current weights, then ask each person which outputs they would have scored differently. Disagreements about outputs usually trace back to criteria that are worded ambiguously. Use the disagreement to sharpen the criterion, not just change the number.",
        href: "/rubrics",
      },
    ],
    guideFaqs: [
      {
        question: "Can I have multiple Rubrics for different use cases?",
        answer:
          "Yes. Create a separate Rubric per use case — one for customer support quality, one for factual accuracy, one for code review. Each Eval Run, Schedule, and Optimization Run selects whichever Rubric applies to what it's measuring.",
      },
      {
        question: "What happens to old Eval Run results when I edit a Rubric?",
        answer:
          "Existing runs are snapshots and won't be retroactively re-scored. To compare results before and after a Rubric change, run a fresh Eval Run on the same batch of outputs you used in the original run and compare the two side by side.",
      },
    ],
  },
  // ── Issue #279: non-technical, problem/use-case-led landers ──────────────────
  // Same template and helpers as the category pages above; distinct angles so they
  // don't cannibalize the generic evaluation page or each other.
  {
    slug: "reduce-ai-hallucinations",
    locales: ["en", "es", "fr"],
    metaTitle:
      "Reduce AI Hallucinations: catch them before customers do | Baseline",
    metaDescription:
      "Hallucinations are confident, wrong answers. Baseline helps you measure how often your AI makes things up, catch new ones on a schedule, and drive the rate down with rubrics built for accuracy.",
    heading: "Reduce AI hallucinations before they reach customers",
    angle:
      "The failure mode buyers fear: confident wrong answers, and how systematic evaluation measures and drives them down.",
    ogSubtitle: "Catch made-up answers before customers do.",
    intro:
      "A hallucination is an answer your AI gives confidently that simply isn't true. You can't stop a model from ever making one, but you can measure how often it happens, catch new ones before they ship, and steadily push the rate down. Baseline gives you the rubric, the scheduled checks, and the optimization loop to do exactly that.",
    explainer: [
      "Hallucinations are dangerous because they're confident. The model doesn't flag the answer as a guess, so a wrong price, a made-up policy, or an invented citation reads exactly like a correct one. By the time a customer notices, the damage is done.",
      "You reduce hallucinations the way you fix any quality problem you can't see: you make it measurable. Define what a grounded, accurate answer looks like, score real outputs against that definition, and \"how often does our AI make things up?\" becomes a number you can watch rather than a feeling you argue about.",
      "Once the rate is measured, you can act on it. Scheduled checks catch a new spike the day a prompt or model changes, and an optimization pass rewrites the prompts that produce the most slips. The number comes down, and you can prove it.",
    ],
    howBaseline: [
      {
        feature: "Accuracy-focused Rubrics",
        body: "Author criteria that reward grounded, verifiable answers and penalize invented facts, so every Eval Run scores how truthful your AI is, not only how fluent it sounds.",
      },
      {
        feature: "A measured hallucination rate",
        body: "Each Eval Run turns a batch of outputs into one readable score, so you can see how often your AI strays and track that number release over release.",
      },
      {
        feature: "Scheduled regression checks",
        body: "A Schedule re-runs the Rubric against your live System on a cadence, so a jump in made-up answers shows up on a dashboard the day it starts, not in a customer complaint.",
      },
      {
        feature: "Optimization that targets the slips",
        body: "Hand the Rubric to an Optimization Run and it searches for prompts that hold the line on accuracy, then proves the drop against the same score.",
      },
    ],
    outcomes: [
      "Put a real number on how often your AI makes things up.",
      "Catch a new spike in hallucinations the day a prompt or model changes.",
      "Reward grounded answers with rubrics your whole team can read.",
      "Show the accuracy improvement, not just claim it.",
    ],
    faqs: [
      {
        question: "Can you actually stop an LLM from hallucinating?",
        answer:
          "Not entirely, and anyone promising zero is overselling. What you can do is measure the rate, catch regressions early, and drive it down with better prompts and grounding. Baseline is built for that loop.",
      },
      {
        question: "How do you measure something as fuzzy as a hallucination?",
        answer:
          "You define what a grounded, accurate answer looks like as rubric criteria, then score outputs against it. The fuzzy worry becomes a number you can track over time.",
      },
      {
        question: "Do I need engineers to set this up?",
        answer:
          "No. A domain expert who knows what a correct answer looks like can author the Rubric in the browser and read the results. Catching hallucinations is a team effort, not a specialist one.",
      },
    ],
    steps: [
      {
        title: "Author an accuracy Rubric",
        description:
          "Create a Rubric with criteria that reward grounded, verifiable answers and penalize invented facts. An example criterion: \"The answer contains no fabricated sources, prices, or policies.\"",
        href: "/rubrics",
        tip: "Write criteria as things a reviewer can check, not attitudes to hold. 'Accurate' is too vague. 'Contains no fabricated sources, prices, or policies' is something the judge can reliably verify.",
        codeExample: `Criterion (60%): The answer contains no fabricated sources, prices, dates, or policies.\nCriterion (25%): Claims in the response can be verified from provided context or known facts.\nCriterion (15%): When the model doesn't know something, it says so rather than guessing.`,
        expectedResult: "Your accuracy Rubric appears in the Rubrics list. Open it and click Run eval to start the baseline Eval Run in step 2 — this first score is the hallucination rate you'll be working to reduce.",
      },
      {
        title: "Run a baseline Eval Run",
        description:
          "Score a batch of real outputs against the Rubric to measure your starting hallucination rate. This gives you a number to track and a threshold to beat.",
        href: "/rubrics",
        tip: "Include some known-bad examples if you have them — outputs you've already caught hallucinating. Seeing them score low confirms the Rubric is catching what you want it to catch.",
        codeExample: `userInput,agentOutput,expectedOutput\n"What is the price of your Pro plan?","The Pro plan costs $29/month.","$49/month"\n"Who founded the company?","It was founded in 2019 by Alex Chen.","Founded in 2021 by Sarah Park."`,
        expectedResult: "An accuracy score for the batch. Known hallucinations should appear as the lowest-scoring rows — if they score high, the Rubric criteria need to be tightened before you trust the number.",
      },
      {
        title: "Review which outputs slipped",
        description:
          "Drill into the lowest-scoring outputs to see which criterion triggered the penalty. Common culprits: invented citations, fabricated data, confident guesses presented as fact.",
        href: "/rubrics",
        tip: "Pattern-matching the failures helps more than reviewing them one by one. If 80% of the slips share a category (citation hallucinations, number errors) that tells you where to focus the prompt fix.",
        expectedResult: "The Eval Run detail view sorted by score, lowest first. Each low-scoring row shows which criterion flagged it — clicking a row opens the judge's reasoning and the exact output text that caused the failure.",
      },
      {
        title: "Set up a scheduled check",
        description:
          "In the Schedules wizard, connect your live AI endpoint and set a cadence. Baseline will call your AI automatically, score for hallucinations, and surface a rate spike on the dashboard the day it starts — not after a customer reports it.",
        href: "/schedules",
        tip: "Schedule the check to run after any deployment that changes a prompt or underlying model. The most common source of a new hallucination spike is a change someone forgot to re-test.",
        expectedResult: "Your Schedule appears in the Schedules list with the next run time. After the first run completes, the Dashboard shows the accuracy score as the first point on a trend line you'll watch over time.",
      },
      {
        title: "Run an Optimization pass",
        description:
          "When the hallucination rate climbs, start an Optimization Run using the same Rubric and the same Connection. Baseline searches for prompts that hold the line on accuracy and shows the before-and-after drop against the same score.",
        href: "/optimizations",
        expectedResult: "An Optimization Run progress view as candidates are generated and scored. When complete, a ranked list of improved prompt candidates appears — each shows a before-and-after accuracy score so you can see exactly how much the hallucination rate improved.",
      },
    ],
    stepsPrereq: [
      "A set of your AI's real outputs to score — include known hallucinations as anchors if you have them",
      "Your AI's endpoint URL and auth credentials for when you set up the scheduled check",
      "Examples of what a correct, grounded answer looks like for your use case",
    ],
    relatedSlugs: ["rubric-based-evaluation", "llm-evaluation", "prompt-optimization"],
    timeToComplete: "~20 min",
    stepsGoal: "By the end, you'll have a measured hallucination rate for your AI and a scheduled check that alerts you the day a new spike starts.",
    difficulty: "Intermediate",
    troubleshooting: [
      {
        problem: "My score goes up and down between runs even though I haven't changed anything",
        solution: "Single-run variance is normal for most LLMs. Look at the 7-day trend in the Dashboard rather than individual runs to separate signal from noise. Your Schedule is designed to surface trending changes, not react to single-run fluctuation.",
        href: "/dashboard",
      },
      {
        problem: "I'm not sure how to write a criterion that catches hallucinations",
        solution: "Be specific about what a hallucination looks like in your domain. 'The response contains no fabricated citations, prices, or policies' is something the judge can reliably check. A vague criterion like 'accurate' gives the judge too much latitude and produces inconsistent scores.",
        href: "/rubrics",
      },
      {
        problem: "My hallucination score is high but users are still reporting made-up answers",
        solution: "Your Eval Run batch probably doesn't include the input types where hallucinations actually happen. Add adversarial examples that push the model to speculate or fill in gaps — specifically input types that match the user reports you're seeing in production.",
        href: "/rubrics",
      },
    ],
    guideFaqs: [
      {
        question: "What's a good hallucination rate to aim for?",
        answer:
          "There's no universal threshold — a medical or legal AI needs much stricter accuracy than a creative-writing tool. Measure your baseline rate first, agree on what's acceptable for your specific use case, and focus on the trend over time rather than the absolute number.",
      },
      {
        question: "Should I add expectedOutput to every row of my CSV?",
        answer:
          "Include it when you have a known-correct answer, because it lets the judge compare the output against ground truth and score more precisely. Skip it for open-ended questions where there's no single right answer — your Rubric criteria handle the scoring in that case.",
      },
    ],
  },
  {
    slug: "ai-agent-testing",
    locales: ["en", "es", "fr"],
    metaTitle: "AI Agent Testing: evaluate agents on a schedule | Baseline",
    metaDescription:
      "AI agents are hard to test because they act, not just answer. Baseline connects to your agent, scores its real outputs against a rubric, and re-runs the check on a schedule so regressions surface fast.",
    heading: "AI agent testing that keeps up with a moving target",
    angle:
      "The use case: testing tool-using agents by connecting to the live agent and scoring its real behavior on a cadence.",
    ogSubtitle: "Test your agent on real behavior, on a schedule.",
    intro:
      "An AI agent doesn't just answer a question. It takes steps, calls tools, and makes decisions. That makes it powerful and hard to test, because the thing you're checking keeps changing as you tweak prompts, swap models, or add tools. Baseline connects to your agent, scores its real outputs against a Rubric, and re-runs that check on a Schedule so you catch a regression while it's still cheap to fix.",
    explainer: [
      "Testing an agent with a few manual prompts tells you it worked once, on the cases you happened to try. Agents fail on the cases you didn't: a tool returns something unexpected, a multi-step plan goes sideways, a model update shifts behavior you relied on.",
      "Real agent testing checks behavior, not a single snapshot. You connect Baseline to the running agent, send a batch of representative inputs through it, and score the actual outputs against criteria you defined. \"Is the agent still doing its job?\" becomes a measurement you can repeat.",
      "Agents drift as everything around them changes, so a one-time test goes stale fast. A scheduled check keeps testing on a cadence, so the day a tool or model change breaks something, you see it on a dashboard rather than hearing it from a user.",
    ],
    howBaseline: [
      {
        feature: "Agent Connections",
        body: "Connect Baseline to your live agent as an agent Connection, so tests run against the real thing producing real outputs, not a stale transcript.",
      },
      {
        feature: "Rubric-scored behavior",
        body: "Score the agent's actual outputs against a Rubric your team authored, so a passing run means it met your definition of doing the job, not just that it returned something.",
      },
      {
        feature: "Scheduled test runs",
        body: "A Schedule re-runs the evaluation on a cadence, so regressions from a new prompt, model, or tool surface within hours rather than after a customer hits them.",
      },
      {
        feature: "From failing test to fix",
        body: "When a run fails, the same Rubric drives an Optimization Run that searches for prompts the agent performs better with, and proves the recovery against the same score.",
      },
    ],
    outcomes: [
      "Test your agent on real behavior, not a handful of manual prompts.",
      "Catch regressions from a model, prompt, or tool change automatically.",
      "Score what \"doing the job\" means in terms your whole team agrees on.",
      "Turn a failing agent test straight into a prompt that does better.",
    ],
    faqs: [
      {
        question: "How is testing an agent different from testing a single prompt?",
        answer:
          "An agent takes multiple steps and uses tools, so the output depends on more than one response. Baseline scores the agent's real end output against your Rubric, and a Schedule keeps testing as the agent changes.",
      },
      {
        question: "Does Baseline run my agent for me?",
        answer:
          "It connects to your agent as an agent Connection and sends representative inputs through it, then scores what comes back. You keep your agent where it is, and Baseline measures it.",
      },
      {
        question: "What happens when a test catches a regression?",
        answer:
          "You see the drop on the dashboard, and the same Rubric can drive an Optimization Run that searches for better prompts and proves the recovery against the same score.",
      },
    ],
    steps: [
      {
        title: "Create a behavior Rubric",
        description:
          "In Rubrics, create a new Rubric with criteria that define what doing the job correctly looks like for your agent — task completion, correct tool use, and response quality are good starting points.",
        href: "/rubrics",
        tip: "Score the final output, not the intermediate steps. 'Completed the task correctly' is a cleaner criterion than 'called the right tool first' — the outcome is what your users experience.",
        codeExample: `Criterion (40%): The agent completed the requested task correctly and completely.\nCriterion (35%): The agent did not take incorrect or unintended actions during execution.\nCriterion (25%): The agent's response clearly confirms what was done and any relevant details.`,
        expectedResult: "Your behavior Rubric appears in the Rubrics list, ready to score agent outputs. Open it to see the criteria — you'll use the Run eval button here in step 3.",
      },
      {
        title: "Collect your agent's outputs",
        description:
          "Run your agent on a representative set of test inputs and save the prompt + response pairs. Include edge cases and any scenarios that have broken the agent before — these make the best test cases.",
        tip: "Agents often fail on inputs you didn't think to test. Make sure your batch includes a few tricky or unusual cases, not just the happy-path scenarios.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Open your Rubric and click Run eval. Provide the prompt + response pairs you collected — by manual entry, CSV upload, or JSON. Baseline scores each output against your behavior criteria and returns an overall score and per-criterion breakdown.",
        href: "/rubrics",
        tip: "A cluster of low scores on the same criterion points to a systemic issue — usually a bad instruction in the system prompt or a tool returning unexpected data. A scattered pattern means the test inputs are too diverse to draw conclusions.",
        codeExample: `userInput,agentOutput\n"Book a meeting for tomorrow at 2pm with Alice.","Done. I've added 'Meeting with Alice' to your calendar for tomorrow at 2:00 PM."\n"Cancel my 3pm appointment.","I found a meeting at 3:00 PM titled 'Team Sync'. I've cancelled it and notified the attendees."`,
        expectedResult: "An overall behavior score and a per-criterion breakdown for each agent output. Low scores under 'task completion' point to instruction issues; low scores under 'no unintended actions' may indicate tool boundary problems.",
      },
      {
        title: "Review the results",
        description:
          "Check the overall score and drill into outputs that scored low. The per-criterion breakdown shows whether the agent failed on task completion, tool use, or something else — and points to where to look in the system prompt.",
        href: "/dashboard",
        tip: "Read the per-criterion reasoning for a few low-scoring outputs, not just the overall number. The reasoning usually tells you exactly which instruction or tool behavior caused the failure.",
        expectedResult: "The Eval Run detail view with a per-criterion breakdown for every agent output. Look for a consistent pattern: if the same criterion scores low across many outputs, the problem is systematic — usually a gap in the system prompt or a tool returning unexpected data.",
      },
      {
        title: "Set up a Schedule",
        description:
          "In the Schedules wizard, connect your live agent endpoint and set a cadence. Baseline will send representative test inputs to the actual running agent, score the outputs, and surface regressions on the dashboard the day they start.",
        href: "/schedules",
        tip: "Agents are especially sensitive to model updates and tool API changes. A scheduled test means you find out about breakage the same day it happens, not from a user report a week later.",
        expectedResult: "Your Schedule appears in the Schedules list with the cadence and next run time. After the first automated run, the Dashboard shows your agent's behavior score as the first data point on a trend line.",
      },
    ],
    stepsPrereq: [
      "A set of test inputs covering the main cases your agent handles, plus known failure cases if you have them",
      "Your agent's endpoint URL and auth credentials for when you set up the Schedule later",
      "A clear sense of what \"doing the job correctly\" means for your agent (you'll write this as Rubric criteria)",
    ],
    relatedSlugs: ["llm-evaluation", "rubric-based-evaluation", "llm-as-judge"],
    timeToComplete: "~20 min",
    stepsGoal: "By the end, you'll have a live evaluation running against your real agent on a schedule, so regressions surface automatically when a prompt, model, or tool changes.",
    difficulty: "Intermediate",
    troubleshooting: [
      {
        problem: "My agent outputs are too unpredictable to get a stable score",
        solution: "Start by scoring only the happy-path inputs — the standard cases your agent was built for. Once you have a stable baseline for those, add edge cases incrementally. A stable score on the happy path is the foundation for meaningful comparisons on harder inputs.",
        href: "/rubrics",
      },
      {
        problem: "I don't know which inputs to include in my Eval Run",
        solution: "Use real user conversations from the past week rather than synthetic examples. Real inputs reflect the actual distribution of what your agent sees, including phrasing and edge cases you wouldn't think to invent. Supplement with any input that caused a production incident.",
        href: "/rubrics",
      },
      {
        problem: "My Schedule passes but I'm still seeing bad agent behavior in production",
        solution: "Your Schedule tests a fixed set of inputs. Bad production behavior usually comes from inputs outside that set. After any production incident, add the triggering input to your Eval Run batch immediately, so the Schedule will cover it in future runs.",
        href: "/schedules",
      },
    ],
    guideFaqs: [
      {
        question: "What if my agent has side effects like sending emails or creating records?",
        answer:
          "Use a sandboxed or dry-run version of your agent for Baseline to connect to. Baseline calls the endpoint URL exactly as configured, so the test endpoint you provide controls whether those side effects actually fire during a Schedule run.",
      },
      {
        question: "How often should I schedule agent tests?",
        answer:
          "After any deployment that changes a prompt, model, or tool is the highest-value cadence. If your agent changes rarely, weekly runs catch environmental drift. If it changes often, run checks after every deploy to catch regressions while the change is fresh.",
      },
    ],
  },
] as const satisfies readonly Category[];

/** Every category slug, derived from the single source (no duplicated list). */
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);

/**
 * The translatable subset of a category (#280). `slug`, `locales`, and the
 * editorial-only `angle` are structural/English and never translated; everything
 * else is rendered prose. A locale's translation file maps each slug to one of
 * these, and the `Required<…>` shape makes a missing field a compile error — so a
 * translation can't ship half-done.
 */
export type CategoryTranslation = Omit<Category, "slug" | "locales" | "angle">;

// Per-locale translations, keyed by slug (#280). `en` is the canonical data above;
// `es`/`fr` overlay their prose at lookup time. Kept in separate files so a native
// reviewer reads one language top to bottom.
const TRANSLATIONS: Partial<
  Record<AppLocale, Record<string, CategoryTranslation>>
> = {
  es: CATEGORIES_ES,
  fr: CATEGORIES_FR,
};

/**
 * Look up a category by slug, resolved into `locale`. The default locale returns
 * the canonical English entry; any other locale overlays its translation. If a
 * non-default locale has no translation the English entry is returned unchanged —
 * but the route's locale-set guard never serves that case, because `locales` is
 * only widened once the translation lands (pinned by the completeness test).
 */
export function getCategory(
  slug: string,
  locale: AppLocale = defaultLocale
): Category | undefined {
  const base = CATEGORIES.find((c) => c.slug === slug);
  if (!base || locale === defaultLocale) return base;
  const translation = TRANSLATIONS[locale]?.[slug];
  return translation ? { ...base, ...translation } : base;
}
