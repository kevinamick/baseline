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
      },
      {
        title: "Add a Connection",
        description:
          "Under Connections, create a Connection pointing to the AI system you want to evaluate. Baseline uses it to send prompts and collect real outputs.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Create an Eval Run, select your Rubric and Connection, and provide a set of representative prompts. Baseline scores each output and returns one overall number plus a per-criterion breakdown.",
      },
      {
        title: "Review the results",
        description:
          "Open the completed Eval Run to see the overall score and drill into any criterion that pulled it down. The breakdown explains exactly why each output scored the way it did.",
      },
      {
        title: "Set up a Schedule",
        description:
          "Create a Schedule to re-run the same Rubric against your live system on a cadence. Regressions surface on the dashboard instead of in customer tickets.",
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
      },
      {
        title: "Add a Connection",
        description:
          "Under Connections, add a Connection to the AI system you want to grade so the judge can score its live outputs, not stale examples.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Create an Eval Run and select your Rubric. Baseline's LLM judge scores every output against your criteria and returns both an overall number and the per-criterion reasoning behind each score.",
      },
      {
        title: "Review the reasoning",
        description:
          "Drill into individual outputs to see which criterion drove a low score. Spot-check any call that surprises you — the reasoning is visible, not a black box.",
      },
      {
        title: "Refine the Rubric",
        description:
          "If the judge's reasoning doesn't match your expectation, edit the criterion that's off. One change in the Rubric updates every future run automatically.",
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
          "Before optimizing, score your current prompt against your Rubric to get a baseline number. This is the score the optimization will try to beat.",
      },
      {
        title: "Start an Optimization Run",
        description:
          "Open Optimization Runs, select your Rubric and the prompt you want to improve, then start the run. Baseline generates and tests candidate prompts automatically.",
      },
      {
        title: "Review the ranked candidates",
        description:
          "The run returns the top candidate prompts ranked by score, each with a before-and-after comparison against the same Rubric.",
      },
      {
        title: "Pick the winner",
        description:
          "Choose the prompt that measurably beats your baseline. The improvement is a number against your own criteria, not a gut feeling.",
      },
      {
        title: "Confirm the lift",
        description:
          "Copy the winning prompt into your AI and run a follow-up Eval Run to confirm the gain holds in production.",
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
      },
      {
        title: "Add weighted criteria",
        description:
          "Add the criteria that define a good output and weight each one by importance. Accuracy might matter more than length, for example. Plain language only — no code required.",
      },
      {
        title: "Run an Eval Run",
        description:
          "Create an Eval Run, select your Rubric, and provide a batch of AI outputs to score. Baseline returns the overall score plus each criterion's individual contribution.",
      },
      {
        title: "Share with your team",
        description:
          "Your Rubric is visible across the team. Team Members can run Eval Runs against it; Readonly Members can view results without being able to change the definition.",
      },
      {
        title: "Reuse across the workflow",
        description:
          "The same Rubric powers one-off Eval Runs, recurring Schedules, and Optimization Runs. Define quality once and reuse it everywhere.",
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
      },
      {
        title: "Run a baseline Eval Run",
        description:
          "Score a batch of real outputs against the Rubric to measure your starting hallucination rate. This gives you a number to track and a threshold to beat.",
      },
      {
        title: "Review which outputs slipped",
        description:
          "Drill into the lowest-scoring outputs to see which criterion triggered the penalty. Common culprits: invented citations, fabricated data, confident guesses presented as fact.",
      },
      {
        title: "Set up a scheduled check",
        description:
          "Create a Schedule to re-run the Rubric on a cadence. A spike in the hallucination rate shows up on the dashboard the day it starts — not after a customer reports it.",
      },
      {
        title: "Run an Optimization pass",
        description:
          "When the rate climbs, start an Optimization Run with the same Rubric. Baseline searches for prompts that hold the line on accuracy and proves the improvement against the same score.",
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
        title: "Add an Agent Connection",
        description:
          "Under Connections, create a new Connection and choose the agent type. Point it at your agent's endpoint so Baseline can send test inputs and collect the real outputs your agent produces.",
      },
      {
        title: "Create a behavior Rubric",
        description:
          "Write a Rubric that defines what doing the job looks like for your agent. Score criteria might include task completion, correct tool use, and response quality.",
      },
      {
        title: "Run an Eval Run against the live agent",
        description:
          "Create an Eval Run, pick the agent Connection and your Rubric, and provide representative test inputs. Baseline routes them through the live agent and scores the actual outputs.",
      },
      {
        title: "Review the results",
        description:
          "Check the overall score and drill into outputs that scored low. The per-criterion breakdown shows whether the agent failed on task completion, tool use, or something else.",
      },
      {
        title: "Set up a Schedule",
        description:
          "Create a Schedule to re-run the Rubric on a cadence. When a prompt, model, or tool update breaks something, the regression shows up on the dashboard that day.",
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
