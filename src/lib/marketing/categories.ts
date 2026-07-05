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

/**
 * One step of the page's guided walkthrough — the "tutorial" spine of the guide.
 * `image` points at a real product screenshot under `public/docs/` (captured at
 * 2880×1800, rendered at 1440×900 via next/image); `alt` is localized prose, so
 * translations carry the whole step including the alt text. Steps may reuse a
 * screenshot another page uses — the step copy, not the pixels, carries the angle.
 */
export interface CategoryStep {
  title: string;
  body: string;
  image?: { src: string; alt: string };
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
  /**
   * The step-by-step tutorial: how a Team actually does this in Baseline, each
   * step illustrated by a product screenshot where one helps. This is the section
   * that makes the guides useful rather than interchangeable — every page walks a
   * genuinely different task.
   */
  walkthrough: readonly CategoryStep[];
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
    walkthrough: [
      {
        title: "Define what good looks like",
        body: "Create a Rubric: describe the scenario, the expected outcome, and the criteria that matter. The editor guides the shape, and plain language is all it takes.",
        image: {
          src: "/docs/rubric-editor.png",
          alt: "The Baseline rubric editor with a scenario description, expected outcome, and evaluation mode filled in for a support reply rubric.",
        },
      },
      {
        title: "Run an eval against real outputs",
        body: "Start an Eval Run from the rubric: bring a batch of inputs and your AI's answers, and Baseline scores every row against the criteria. Each run lands in the rubric's history with its overall score.",
        image: {
          src: "/docs/rubrics-runs-panel.png",
          alt: "A rubric's Eval Run history in Baseline, five completed runs with scores rising from 56% to 82%.",
        },
      },
      {
        title: "Read the score, then the reasons",
        body: "Open a run to see the per-row, per-criterion breakdown. Every score comes with the judge's written reasoning, so a weak row tells you exactly what to fix.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "An Eval Run detail in Baseline showing an 82% overall score and per-criterion reasoning for accuracy, completeness, and tone.",
        },
      },
      {
        title: "Watch the trend, catch the drift",
        body: "The dashboard tracks every rubric's score over time, and a Schedule keeps runs coming on a cadence. A regression shows up as a dip on the chart the day it happens.",
        image: {
          src: "/docs/dashboard-score-trend.png",
          alt: "The Baseline dashboard with a score-over-time chart climbing from 56% to 82% and a per-criterion focus panel.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rubrics",
        body: "One shared definition of quality, written once in plain language and used by every run, schedule, and optimization that follows.",
      },
      {
        feature: "Eval Runs",
        body: "A batch of outputs becomes one score the whole team can read, with the per-criterion detail behind it.",
      },
      {
        feature: "Schedules",
        body: "Recurring runs against your live System keep the measurement current while everyone stays focused on the product.",
      },
      {
        feature: "Optimization Runs",
        body: "When the score dips, the same rubric drives an automated search for better prompts and proves the recovery.",
      },
    ],
    outcomes: [
      "Replace \"looks fine to me\" with a quality score your whole team trusts.",
      "Catch regressions the day a model, prompt, or vendor changes.",
      "Give non-technical teammates a direct read on AI quality.",
      "Turn every evaluation into the starting point for the next improvement.",
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
    walkthrough: [
      {
        title: "Give the judge written instructions",
        body: "Each criterion carries scoring steps: short, ordered instructions the judge follows the same way every time. Weights say how much each criterion moves the overall score.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Weighted criteria in the Baseline rubric editor, each with plain-language scoring steps for the judge to follow.",
        },
      },
      {
        title: "The judge scores and shows its work",
        body: "On every row of an Eval Run, the judge scores each criterion and writes down why. The reasoning sits next to the number, so a 0.80 on accuracy comes with the sentence that cost the points.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Per-criterion judge scores with written reasoning in a Baseline Eval Run detail.",
        },
      },
      {
        title: "Same standard, comparable runs",
        body: "Because the criteria and steps are fixed, scores line up run to run. The history reads as a trend of your AI's quality, graded by the same standard every time.",
        image: {
          src: "/docs/rubrics-runs-panel.png",
          alt: "Five Eval Runs of the same rubric in Baseline, scored by identical criteria across two months.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rubric-anchored judging",
        body: "The judge grades against the weighted criteria your team wrote, so every score traces back to a standard you can read and edit.",
      },
      {
        feature: "Scoring steps",
        body: "Each criterion gives the judge explicit steps to follow. Consistency comes from written instructions, the same way it does for a trained human reviewer.",
      },
      {
        feature: "Reasoning you can audit",
        body: "Every criterion score arrives with the judge's written justification, ready to spot-check, challenge, or use to sharpen the rubric.",
      },
      {
        feature: "Your provider, your key",
        body: "Bring your own Anthropic, OpenAI, Google, or Mistral key and the judge runs on it. Paid Teams can also lean on Baseline's managed key.",
      },
    ],
    outcomes: [
      "Grade thousands of outputs in minutes, at any volume.",
      "See the reason behind every score, per criterion, per row.",
      "Keep runs comparable because the grading standard holds still.",
      "Spot-check the judge and keep your team as the final word.",
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
          "Drift comes from vague instructions. Scoring against fixed, weighted criteria and written steps makes runs comparable, so a score change reflects a change in your AI.",
      },
      {
        question: "Which model does the judging?",
        answer:
          "Whichever provider your Team has a key for: bring an Anthropic, OpenAI, Google, or Mistral key and judging runs on it at your own token cost. Paid Teams without a key run on Baseline's managed key.",
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
    walkthrough: [
      {
        title: "Point a run at a rubric and an agent",
        body: "Pick the Rubric that defines success, the agent Connection whose prompt you want to improve, and a rollout budget. The run freezes a set of input Instances up front, so every candidate is judged on identical ground.",
      },
      {
        title: "Baseline searches, scores, and keeps the winners",
        body: "The run proposes prompt variants and tests each one against the frozen inputs. Reflective mode reads the judge's written feedback and rewrites with intent; Simple mode samples rewrites and keeps the best scorers.",
      },
      {
        title: "Ship the lift, with the proof attached",
        body: "The run reports before and after scores against your rubric and lays the optimized prompt beside the seed for every Module. Copy it out when you're convinced.",
        image: {
          src: "/docs/optimization-run.png",
          alt: "A completed Optimization Run in Baseline showing a score lift from 74% to 86% and the seed prompt beside the optimized version.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Optimization Runs",
        body: "Point a run at the prompt you want improved, set a budget, and it explores candidates while your team does something else.",
      },
      {
        feature: "Two Modes",
        body: "Simple Mode samples scored rewrites and keeps the best, suited to narrow tasks. Reflective Mode learns from the judge's written feedback, built for demanding rubrics.",
      },
      {
        feature: "Proven lift",
        body: "Every run reports before and after scores on the same rubric you evaluate with, so the gain is measured before you ship it.",
      },
      {
        feature: "Prompts you can take with you",
        body: "Winning prompts sit beside their seeds, per Module, with one-click copy. Your agent, your prompt, your call.",
      },
    ],
    outcomes: [
      "Recover the engineering weeks spent hand-tuning prompt wording.",
      "Let domain experts drive prompt quality through the rubric they own.",
      "Ship prompt changes with the before-and-after number attached.",
      "Turn a failed evaluation directly into a better prompt.",
    ],
    faqs: [
      {
        question: "How is this different from a prompt playground?",
        answer:
          "A playground helps you try prompts one at a time and judge by eye. An Optimization Run tests many candidates for you and scores each against your rubric, so the winner is the one that measurably performs.",
      },
      {
        question: "How do I know the new prompt is actually better?",
        answer:
          "Every run reports the before-and-after score on the same rubric you evaluate with, and shows the optimized prompt side by side with the seed, so you review exactly what changed and what it gained.",
      },
      {
        question: "What is a Module?",
        answer:
          "A named prompt inside your agent that a run can improve on its own. An agent Connection declares its Modules; a run optimizes one at a time and reports each prompt separately.",
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
    walkthrough: [
      {
        title: "Set the scene",
        body: "A rubric starts with a scenario description and an expected outcome in plain language: what the AI is being asked to do, and what a good answer achieves. Optional grounding context gives the judge reference material to check against.",
        image: {
          src: "/docs/rubric-editor.png",
          alt: "The rubric editor's scenario description, expected outcome, and grounding context fields in Baseline.",
        },
      },
      {
        title: "Weight what matters",
        body: "Add criteria and weight them so the overall score reflects your priorities. Scoring steps under each criterion tell the judge exactly how to grade it, in your team's words.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "Three weighted criteria in the Baseline rubric editor: accuracy at 0.5, completeness at 0.3, and tone at 0.2, each with scoring steps.",
        },
      },
      {
        title: "One rubric, every measurement",
        body: "The finished rubric drives one-off Eval Runs, recurring Schedules, and Optimization Runs alike. Edit the definition once and everything downstream measures against the update.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "A Baseline Schedule running a rubric nightly against a connected agent, with its run history.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Scenario and expected outcome",
        body: "The rubric captures the task and the target in prose first, so the criteria have context and a new teammate can read what good means here.",
      },
      {
        feature: "Weighted criteria",
        body: "Name the dimensions of quality and weight them by importance. Weights sum to 1, so priorities are explicit and the overall score reflects them.",
      },
      {
        feature: "Scoring steps",
        body: "Each criterion carries the step-by-step instructions the judge follows, turning a label like Accuracy into a repeatable procedure.",
      },
      {
        feature: "Team ownership",
        body: "Contributors author and edit in the browser; Readonly Members see every result while the standard stays stable.",
      },
    ],
    outcomes: [
      "Every reviewer, human or automated, scores against one written standard.",
      "Quality becomes an explicit written artifact the team owns.",
      "Domain experts define good directly, in the browser.",
      "One rubric powers evaluation, monitoring, and optimization.",
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
    walkthrough: [
      {
        title: "Write criteria that reward grounded answers",
        body: "Give accuracy the heaviest weight and spell out the scoring steps: compare against the expected answer, penalize invented facts. Grounding context hands the judge the reference material to check claims against.",
        image: {
          src: "/docs/rubric-editor-criteria.png",
          alt: "An accuracy-weighted rubric in Baseline with scoring steps that penalize factual errors and omissions.",
        },
      },
      {
        title: "Score a real batch and see where it strays",
        body: "Run an eval over real outputs. The per-row breakdown shows which answers slipped, and the judge's reasoning names the exact claim that cost the points.",
        image: {
          src: "/docs/eval-run-detail.png",
          alt: "Judge reasoning in a Baseline Eval Run flagging a softened detail in an otherwise accurate support reply.",
        },
      },
      {
        title: "Put the check on a schedule",
        body: "A nightly or hourly Schedule re-scores fresh outputs from your live System, so a spike in made-up answers surfaces on the very next tick.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "A nightly Baseline Schedule scoring a live support agent, with completed runs in its history.",
        },
      },
      {
        title: "Drive the rate down and prove it",
        body: "The dashboard shows the accuracy trend. When it dips, an Optimization Run searches for prompts that hold the line and reports the recovery as a number.",
        image: {
          src: "/docs/dashboard-score-trend.png",
          alt: "A rising accuracy trend on the Baseline dashboard after prompt fixes.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Accuracy-first Rubrics",
        body: "Criteria that reward grounded, verifiable answers, weighted so accuracy dominates the overall score.",
      },
      {
        feature: "Grounding context",
        body: "Attach the reference material the judge checks claims against, so \"true\" means true to your own docs and policies.",
      },
      {
        feature: "A measured rate",
        body: "Each run turns a batch into a number, and the per-row reasoning names each invented fact it found.",
      },
      {
        feature: "Checks that keep running",
        body: "Schedules re-score live outputs on a cadence; a model or prompt change that starts slipping shows up in the next run.",
      },
    ],
    outcomes: [
      "Put a real number on how often your AI makes things up.",
      "See the exact claims that failed, with the judge's reasoning.",
      "Catch a spike within one scheduled run of it starting.",
      "Show the accuracy improvement as a trend, with the receipts.",
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
        question: "What makes a rubric good at catching hallucinations?",
        answer:
          "Three things: an expected outcome the judge can compare against, grounding context that supplies the true reference material, and scoring steps that explicitly penalize invented facts. The walkthrough above sets up all three.",
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
    walkthrough: [
      {
        title: "Connect the agent you actually run",
        body: "An agent Connection points Baseline at your live endpoint: URL, auth header, a request template, and the response path to the answer. Credentials are encrypted at rest and decrypted only server-side, at the moment Baseline calls your system.",
        image: {
          src: "/docs/schedule-wizard-connection.png",
          alt: "Creating a live agent Connection in Baseline's schedule wizard, with endpoint URL, auth header, and request body template.",
        },
      },
      {
        title: "Name the test and pick the standard",
        body: "The schedule wizard walks you through Basics, System, Inputs, Cadence, Notify, and Review: choose the Rubric that defines the job done well and the inputs Baseline sends through the agent.",
        image: {
          src: "/docs/schedule-wizard-step1.png",
          alt: "The schedule wizard's first step in Baseline, naming a nightly support-reply check and selecting a rubric.",
        },
      },
      {
        title: "Let the cadence catch the drift",
        body: "Every tick, Baseline invokes the agent with representative inputs and scores the real outputs. Run history turns tool changes, model swaps, and prompt edits into visible score moves.",
        image: {
          src: "/docs/schedules-page.png",
          alt: "A Baseline Schedule's run history for a live support agent, with per-run scores and next-run time.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Agent Connections",
        body: "A reusable definition of how Baseline reaches your agent: endpoint, auth, request template, response path. Tests run against the real thing, live.",
      },
      {
        feature: "Credentials handled server-side",
        body: "Connection secrets are encrypted at rest and in transit, and decrypted only when the worker calls your system.",
      },
      {
        feature: "Scheduled test runs",
        body: "A cadence you choose, from hourly to monthly, with completion and failure notifications to the teammates who care.",
      },
      {
        feature: "Dataset sources too",
        body: "Point a dataset Connection at PostHog or a custom source and score the traffic your agent already produced, with zero live calls.",
      },
    ],
    outcomes: [
      "Test the agent's real behavior on a cadence, hands-free.",
      "Catch regressions from model, prompt, or tool changes in the next run.",
      "Define \"doing the job\" once, in terms the whole team agreed on.",
      "Score historic production traffic as easily as live invocations.",
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
        question: "Is it safe to give Baseline my agent's API credentials?",
        answer:
          "Connection secrets are stored encrypted, never exposed to the browser, and decrypted only server-side at the moment Baseline calls your endpoint. You can rotate or delete a Connection's credentials at any time.",
      },
      {
        question: "What happens when a test catches a regression?",
        answer:
          "You see the drop on the dashboard, and the same Rubric can drive an Optimization Run that searches for better prompts and proves the recovery against the same score.",
      },
    ],
  },
  {
    slug: "simple-prompt-optimization",
    locales: ["en", "es", "fr"],
    metaTitle: "Simple Mode: fast prompt optimization for narrow tasks | Baseline",
    metaDescription:
      "Simple Mode improves a pasted prompt by trying scored rewrites and keeping the best. Learn when to choose it over Reflective Mode, what every run option does, and how a run is billed.",
    heading: "Simple Mode: prompt optimization with fewer decisions",
    angle:
      "The product guide to the Simple Optimization Mode: when a score-only search beats feedback-driven optimization, and what every run option does.",
    ogSubtitle: "Paste a prompt. Keep the best rewrite.",
    intro:
      "Simple Mode is the fastest way to improve a prompt in Baseline. Paste the prompt, add a handful of test inputs, and the run tries rewrite after rewrite, scores each one against your Rubric on the same inputs, and hands back the best version it found. It is the default Mode when you optimize a pasted prompt, and it asks you for exactly one real decision: how many scored calls you want to spend.",
    explainer: [
      "An Optimization Run in Simple Mode is a tournament of rewrites. Your pasted prompt is the first Candidate and gets scored on the full set of test inputs, called Instances, to set the baseline. Each round then produces up to 8 new Candidates: each starts from one of the current best prompts and rewrites it in one of five ways, such as making it more specific, adding a worked example, restructuring it as numbered steps, tightening it, or reframing its perspective.",
      "Every Candidate is scored on the same frozen Instances by the same Rubric, so scores are directly comparable. After each round the run keeps the top 3 and rewrites from those. It stops when it hits the rollout budget, the round cap, or several rounds in a row with no improvement, and completes on the best Candidate found, with its score shown next to your original prompt's.",
      "The other Optimization Mode, Reflective, reads the judge's written reasoning on recent scores and proposes prompts informed by that feedback. Choose Simple for a narrow, well-defined task such as a JSON formatter, a classifier, or an extractor, where the score already tells the whole story. Switch to Reflective when the Rubric's criteria are nuanced, like tone or judgment calls, and the optimizer should learn from feedback rather than a number alone.",
    ],
    walkthrough: [
      {
        title: "Pick the Rubric that defines better",
        body: "Every rewrite is scored against one Rubric, so the run optimizes exactly what the Rubric measures. Choose an existing one on the Basics step, or write one first if this prompt has never been evaluated.",
      },
      {
        title: "Paste your prompt and keep Simple selected",
        body: "On the System step, choose Paste a prompt, drop in the prompt, and pick the model it should run on: Haiku 4.5 by default, or Sonnet 4.6 or Opus 4.8. Simple is preselected as the Mode; Reflective is one click away when the task needs it.",
      },
      {
        title: "Add the test inputs",
        body: "Enter up to 50 Instances by hand, or upload them as CSV or JSON. Only the user input is required; an expected output and retrieval context are optional. The set freezes when the run starts, so every Candidate is judged on identical inputs.",
      },
      {
        title: "Set the budget, and tune the rest only if you want to",
        body: "The rollout budget caps scored calls: one rollout is one Candidate scored on one Instance, the default is 30, and your plan sets the per-run maximum (200 on Builder, 400 on Scale). Advanced settings hold the rewrite model (the fast model by default), the round cap (20), and the early stop after rounds without improvement (5).",
      },
      {
        title: "Review, start, and collect the winner",
        body: "The Review step shows the Mode, the Instance count, the budget, and whether the run uses an included Optimization Run or meters Eval Points. When the run completes you get before and after scores and the optimized prompt beside your original, ready to copy out.",
        image: {
          src: "/docs/optimization-run.png",
          alt: "A completed Optimization Run in Baseline showing a score lift from 74% to 86% with the original prompt beside the optimized version.",
        },
      },
    ],
    howBaseline: [
      {
        feature: "Rubrics",
        body: "Your definition of quality is the run's fitness function: every rewrite is scored against the same criteria your Eval Runs already use.",
      },
      {
        feature: "Managed Agents",
        body: "Baseline runs the pasted prompt on a managed model, so there is no endpoint to build and nothing to deploy before you can optimize.",
      },
      {
        feature: "Optimization Runs",
        body: "A Simple run draws from your plan's monthly run allowance like any Mode, and the rollout budget keeps its cost bounded before it starts.",
      },
      {
        feature: "Reflective Mode",
        body: "The same wizard offers the feedback-driven Mode when your Rubric's criteria get nuanced, so outgrowing Simple is a one-click switch.",
      },
    ],
    outcomes: [
      "Improve a prompt without connecting an agent or writing an endpoint.",
      "A measured before-and-after score against your own Rubric, on the same inputs.",
      "One decision to make: the budget. Sensible defaults handle the rest.",
      "A clear upgrade path to feedback-driven optimization when the task outgrows score-only search.",
    ],
    faqs: [
      {
        question: "When should I use Reflective Mode instead?",
        answer:
          "When the Rubric measures nuanced qualities, such as tone, empathy, or multi-part instructions that interact. Reflective reads the judge's written reasoning and proposes prompts informed by it. Simple is the better fit when the score alone captures success.",
      },
      {
        question: "How should I size the rollout budget?",
        answer:
          "Every Candidate is scored on the full Instance set, so one Candidate costs as many rollouts as you have Instances, and the baseline scoring of your original prompt counts too. A useful rule of thumb is instances times the number of rewrites you want to try, plus one. With 10 Instances, a budget of 250 covers the baseline plus three full rounds of 8 rewrites.",
      },
      {
        question: "Why don't I see Simple Mode in my wizard?",
        answer:
          "Simple Mode is offered for pasted prompts, which run as Managed Agents on Baseline's own key, a paid-plan feature. Agents connected over your own endpoint optimize with Reflective Mode.",
      },
      {
        question: "What does a run cost?",
        answer:
          "One Optimization Run from your plan's monthly allowance (15 on Builder, 75 on Scale); past the allowance a paid run meters Eval Points per scored rollout instead, and the Review step tells you which applies before you start. Model tokens run on your own provider key when you've saved one, otherwise on Baseline's managed key at provider cost plus your plan's markup, reserved against your Managed Spend Cap.",
      },
      {
        question: "What happens if a run hits the spend cap partway through?",
        answer:
          "The run fails immediately and your original prompt stays in place, so a capped run never quietly reports your unchanged prompt as an optimized result. Raise the cap or wait for the next period, then run again.",
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
