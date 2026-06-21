import type { AppLocale } from "@/i18n/routing";

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

export interface Category {
  /** Flat top-level URL slug: `/{slug}` (a head term). */
  slug: string;
  /**
   * The set of locales this page actually exists in (ADR-0013). `["en"]` at
   * launch: only `en` is served, the page self-canonicals and emits no `es`/`fr`
   * `hreflang`, and `/es|fr/{slug}` are not crawlable. Widen this **only** when the
   * matching translation actually lands (issue #280), never "to match the rest of
   * the app" (see ADR-0013's failure-mode note).
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
}

// Single source of truth. The surface grows by appending here (issue #279 adds the
// non-technical landers the same way). `as const` keeps slugs/locales literal.
export const CATEGORIES = [
  {
    slug: "llm-evaluation",
    locales: ["en"],
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
  },
  {
    slug: "llm-as-judge",
    locales: ["en"],
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
  },
  {
    slug: "prompt-optimization",
    locales: ["en"],
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
  },
  {
    slug: "rubric-based-evaluation",
    locales: ["en"],
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
  },
  // ── Issue #279: non-technical, problem/use-case-led landers ──────────────────
  // Same template and helpers as the category pages above; distinct angles so they
  // don't cannibalize the generic evaluation page or each other.
  {
    slug: "reduce-ai-hallucinations",
    locales: ["en"],
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
  },
  {
    slug: "ai-agent-testing",
    locales: ["en"],
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
  },
] as const satisfies readonly Category[];

/** Every category slug, derived from the single source (no duplicated list). */
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);

/** Look up a category by its URL slug. */
export function getCategory(slug: string): Category | undefined {
  return CATEGORIES.find((c) => c.slug === slug);
}
