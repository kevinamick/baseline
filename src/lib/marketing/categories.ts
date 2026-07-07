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
  /**
   * A literal block of text meant to be copied verbatim, e.g. a prompt the reader
   * pastes into a chat assistant (#432). Rendered preformatted, in place of `image`
   * on the step that needs it — a step carries one or the other, never both.
   */
  codeBlock?: string;
}

/**
 * An explicit end-of-guide cross-link to a related guide (#432), rendered right
 * after the `howBaseline` grid. Optional — most guides have none; a "DIY path"
 * lander closes by pointing at the automated equivalent.
 */
export interface CategoryClosingLink {
  /** Link text, e.g. "See how Baseline automates this loop". */
  label: string;
  /** Internal path this guide closes to, e.g. "/prompt-optimization". */
  href: string;
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
  /**
   * An optional explicit cross-link rendered right after the `howBaseline` grid
   * (#432), e.g. a "DIY path" guide pointing at the automated equivalent.
   */
  closingLink?: CategoryClosingLink;
  /** Outcome bullets, what a team gets, in plain language. */
  outcomes: readonly string[];
  /** Buyer FAQs (also good for featured snippets). */
  faqs: readonly CategoryFaq[];
}

// The manual-prompt-optimization guide's copy-paste prompt (#432): the page's real
// product. Built as a joined array (not one long template literal) so it stays
// readable in source without picking up the surrounding indentation as literal
// leading whitespace in the rendered <pre> block. Vocabulary-firewall constraint
// applies here too — plain "revision"/"round"/"prompt version" language only, never
// the product/technique lexicon a translator or assistant might otherwise reach for.
const MANUAL_LOOP_PROMPT_EN = [
  "You are helping me manually improve an AI prompt through structured rounds of testing and revision. Here is how to run this with me:",
  "",
  "1. Ask me for three things if I haven't already given them: my current prompt, a set of test cases (each one an input plus either an expected output or a plain description of what a good answer looks like), and the criteria I'll judge answers by. If anything is missing, help me build it before we start.",
  "2. Once you have the prompt, test cases, and criteria, proceed immediately to scoring. Do not ask for more test cases, do not request numeric weights, do not ask for concrete examples if abstract descriptions were provided. Work with exactly what you have been given. Treat abstract or pattern-style test cases as valid inputs; interpret them reasonably and score against them directly.",
  "3. Run the current prompt against every test case. For each case, reason through what the prompt would likely produce and score it against the criteria. Record all scores in a table so we have a clear starting point.",
  "4. Look across every scored case and name the single failure pattern that shows up most often: the one costing the most points across the whole set. Not every small issue, just the dominant one.",
  "5. Make exactly one focused change to the prompt that targets that pattern. Do not rewrite the whole prompt. Do not fix multiple things at once.",
  "6. Score the revised prompt against the exact same test cases using the exact same criteria. Record the new scores in a table.",
  "7. Compare the new total to the previous round. If it improved, keep the revision and return to step 4. If it did not improve, revert to the previous best prompt and try a different angle on the same failure pattern.",
  "8. Repeat steps 4 through 7. Stop after 5 rounds, or after 2 consecutive rounds with no improvement, whichever comes first.",
  "9. When you stop, deliver all three of the following without waiting to be asked:",
  "   - The final prompt in full, ready to copy",
  "   - A table showing the score before and after for every test case across all rounds",
  "   - A short plain-language summary of what changed and why it helped",
  "",
  "Two rules for the whole run: never change the test cases once we start, and judge every change by what it does to the whole set, never by whether it fixes one favorite case at the expense of others.",
].join("\n");

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
        image: {
          src: "/docs/optimization-wizard-system-simple.png",
          alt: "The optimization wizard's System step with Paste a prompt chosen, Simple selected as the Optimization mode, and a support-ticket triage prompt filled in.",
        },
      },
      {
        title: "Add the test inputs",
        body: "Enter up to 50 Instances by hand, or upload them as CSV or JSON. Only the user input is required; an expected output and retrieval context are optional. The set freezes when the run starts, so every Candidate is judged on identical inputs.",
        image: {
          src: "/docs/optimization-wizard-instances.png",
          alt: "The optimization wizard's Instances step with three support tickets entered manually, each with a user input and an expected output.",
        },
      },
      {
        title: "Set the budget, and tune the rest only if you want to",
        body: "The rollout budget caps scored calls: one rollout is one Candidate scored on one Instance, the default is 30, and your plan sets the per-run maximum (200 on Builder, 400 on Scale). Advanced settings hold the rewrite model (the fast model by default), the round cap (20), and the early stop after rounds without improvement (5).",
        image: {
          src: "/docs/optimization-wizard-tuning.png",
          alt: "The optimization wizard's Tuning step showing a rollout budget of 30, the Haiku 4.5 generation model, and advanced settings with max rounds 20 and the early stop at 5.",
        },
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
          "Every Candidate is scored once per Instance, and your Instance count is simply how many test rows you added on the Instances step. So with 10 Instances, each rewrite costs 10 rollouts, and scoring your original prompt at the start costs the same 10. To size the budget, count the prompts you want scored (your original plus every rewrite) and multiply by your Instance count. For example: trying 24 rewrites (three full rounds of 8) on 10 Instances means 25 scored prompts, so set a budget of 250.",
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
  {
    slug: "ai-eval-pricing",
    locales: ["en", "es", "fr"],
    metaTitle: "Eval Points: predictable usage pricing for AI evaluation | Baseline",
    metaDescription:
      "Eval Points are the unit Baseline's evaluation work is priced in. Learn the exact per-run arithmetic, what happens when a run fails, each plan's monthly allowance, and how overage stays under a cap you set.",
    heading: "Eval Points, explained",
    angle:
      "The pricing-mechanics explainer: what an Eval Point measures, the exact per-run arithmetic, and the reserve-and-settle ledger behind predictable usage billing.",
    ogSubtitle: "Know every run's cost before it starts.",
    intro:
      "Eval Points are how Baseline prices evaluation work. Every Eval Run's cost is exact arithmetic you can check before it starts, your plan includes a monthly allowance, and an append-only ledger shows every movement. Token costs live on a separate meter, so the number you see is the whole platform price.",
    explainer: [
      "An Eval Point measures platform work: orchestrating a run and scoring your outputs against your Rubric's criteria. Each row costs 10 points of orchestration plus 5 points per criterion scored. A 3-criteria Rubric therefore costs 25 points per row, so a 100-row Eval Run against it costs exactly 2,500 points. The math is fixed and public, and the run dialog does it for you before you confirm.",
      "Model token costs ride a separate meter, by design. When your Team brings its own provider key, Baseline charges nothing for tokens at all; when a run uses Baseline's managed key, the tokens are billed at provider cost plus your plan's markup under a Managed Spend Cap you can see and edit. Keeping the two meters apart is what makes each of them predictable.",
      "Points move through an append-only ledger with reserve-and-settle semantics. When a run starts, its full cost is reserved in one atomic step, which is why simultaneous runs can never overshoot your allowance. When the run reaches its end, it settles: a completed run keeps the full reservation, and a failed run settles for only the rows it actually executed, releasing the rest back to your balance. The ledger you see on the Billing page is the audit trail itself, entry by entry.",
      "Optimization Runs draw on their own allowance first: your plan includes a number of runs per month (15 on Builder, 75 on Scale), and a run within that allowance uses zero points. Past the allowance, a paid Team's run meters Eval Points per scored rollout, priced by the same per-row formula, because judging one rollout is the same platform work as scoring one eval row.",
    ],
    walkthrough: [
      {
        title: "See the exact cost before any run starts",
        body: "The Run eval dialog totals the arithmetic live as you add rows: rows times 10, plus 5 per criterion per row. One row against a 3-criteria Rubric reads 25 Eval Points. Nothing runs until you confirm the number.",
        image: {
          src: "/docs/eval-run-dialog-points.png",
          alt: "The Run eval dialog in Baseline with one manual row filled in and the footer reading: this run will use 25 Eval Points.",
        },
      },
      {
        title: "Track your balance and reset date on Billing",
        body: "The Billing page shows your remaining points, your plan's monthly allowance (5,000 on Free, 100,000 on Builder, 500,000 on Scale), and the day the balance resets with your billing period.",
        image: {
          src: "/docs/billing-eval-points.png",
          alt: "The Baseline Billing page for a Builder team showing 100,000 of 100,000 Eval Points remaining, the reset date, and the Overage card.",
        },
      },
      {
        title: "Watch runs reserve, then settle",
        body: "Starting a run reserves its full cost on the Point Ledger in one atomic entry. Finishing settles it: a completed run keeps the reservation, a failed run pays only for the rows it processed and releases the remainder. Every movement stays visible as its own ledger line.",
      },
      {
        title: "Decide what happens at the limit",
        body: "By default runs stop when the allowance is spent, so the plan price is the whole bill. Paid Teams can set an Overage Cap in dollars to let runs continue at the plan's per-point rate ($0.0005 on Builder, $0.0003 on Scale), never past the cap, with a warning email at 80% of it.",
      },
    ],
    howBaseline: [
      {
        feature: "Eval Runs",
        body: "Cost exact arithmetic per row and criterion, shown in the dialog before you start, and the same whether a run is manual or scheduled.",
      },
      {
        feature: "Optimization Runs",
        body: "Use their own monthly run allowance first; past it, a run meters points per scored rollout with the same per-row formula.",
      },
      {
        feature: "Point Ledger",
        body: "An append-only record on the Billing page: grants, reserves, settlements, and releases, so the balance always explains itself.",
      },
      {
        feature: "Overage Cap",
        body: "An opt-in dollar ceiling that lets paid Teams keep running past the allowance at a fixed per-point rate, never beyond the cap.",
      },
    ],
    outcomes: [
      "Know every run's exact cost before it starts, in one visible formula.",
      "A plan bill that stays the plan price unless you opt into capped overage.",
      "Failed runs settle for the work actually done, with the rest released back.",
      "Token costs on their own transparent meter, at zero when you bring your own key.",
    ],
    faqs: [
      {
        question: "Do Eval Points include model token costs?",
        answer:
          "Points cover platform work only: orchestration and criterion scoring. Tokens are a separate meter. With your own provider key, Baseline adds nothing on top of your provider bill; on Baseline's managed key, tokens are billed at provider cost plus your plan's markup, under a Managed Spend Cap you control.",
      },
      {
        question: "What consumes Eval Points?",
        answer:
          "Eval Runs, whether started by hand or by a Schedule, at rows times (10 plus 5 per criterion). Optimization Runs consume points only after your plan's included run allowance is used, at the same rate per scored rollout. Nothing else draws points.",
      },
      {
        question: "What happens to the points when a run fails?",
        answer:
          "The reservation settles down to the rows the run actually executed and the remainder is released back to your balance, as its own ledger entry. A run that dies at row 30 of 100 pays for 30 rows.",
      },
      {
        question: "What happens when my Team runs out?",
        answer:
          "New runs are refused until the balance resets with your billing period. On a paid plan you can instead set an Overage Cap: runs then continue at the per-point rate up to your cap, you get a warning email at 80% of it, and the cap is the most overage can ever bill. Free plans always stop at the allowance.",
      },
      {
        question: "Why points instead of a dollar meter?",
        answer:
          "Platform work is countable and identical run to run, so it prices cleanly in fixed units you can verify. Token costs vary by model and provider, so they stay on their own meter where each charge maps to a specific call at a visible rate.",
      },
    ],
  },
  {
    slug: "manual-prompt-optimization",
    locales: ["en", "es", "fr"],
    metaTitle: "Manual Prompt Optimization: the DIY loop, step by step | Baseline",
    metaDescription:
      "Manual prompt optimization means freezing a test set, scoring against fixed criteria, and running an AI assistant through one focused revision at a time. Get the full loop, the copy-paste prompt that runs it, and when it's worth automating with Baseline.",
    heading: "Optimize a prompt by hand, one honest round at a time",
    angle:
      "The DIY path: freezing a test set, scoring by hand, and looping an AI assistant through revisions, honest about what it costs in hours.",
    ogSubtitle: "The DIY prompt loop, step by step.",
    intro:
      "You can make a prompt meaningfully better without buying anything. Freeze a real test set, score the current prompt against a fixed set of criteria, then hand the revision work to an AI assistant you already use: change one thing, re-score, and keep the change only when the total goes up. Repeat a handful of times and most prompts improve noticeably in an afternoon. The real cost is your time, and knowing exactly when that cost stops being worth it.",
    explainer: [
      "Most people improve a prompt by eyeballing it: change a sentence, glance at a couple of outputs, decide it feels better, move on. The trouble is you can't actually tell. Without a fixed way to measure \"better,\" every edit is a guess dressed up as a decision.",
      "The fix doesn't take any special software. Freeze a real set of test cases so the ground never shifts under you, write down the criteria you're judging by, change exactly one thing at a time, and score the result against the same cases and the same criteria every round. That discipline, on its own, turns hand-tuning into something you can actually trust.",
      "The part that's genuinely tedious is running that loop over and over: score, spot the pattern, revise, re-score, compare. That's mechanical work, and it's exactly what a chat assistant can take off your hands once you give it the right instructions. This guide walks the whole thing end to end, including the exact prompt to hand it.",
    ],
    walkthrough: [
      {
        title: "Freeze a test set",
        body: "Pick 10 to 20 real inputs, the kind your prompt actually has to handle, not invented edge cases. For each one, write down either the expected output or, when there's no single right answer, a plain description of what a good answer looks like. Keep this exact set unchanged for every round that follows; a moving target makes every score meaningless.",
      },
      {
        title: "Score the current prompt against written criteria",
        body: "Before changing anything, run the current prompt against every case and score each result against a fixed, written set of criteria, not a gut feeling. A spreadsheet with one row per case and one column per criterion genuinely works: write a score and a one-line reason in each cell. If you'd rather have a dedicated place to store and re-run these scores, platforms like LangSmith and Braintrust do the same job. Either way, write the scores down before you touch the prompt, so you have a real number to beat.",
      },
      {
        title: "Hand the loop to an AI assistant",
        body: "The repetitive part, running the same instructions round after round, is exactly what a chat assistant is good at. Claude, ChatGPT, Copilot, and Codex all handle this about the same; use whichever you already have open. Paste the block below into a fresh chat, then answer its questions about your prompt, your test cases, and your criteria.",
        codeBlock: MANUAL_LOOP_PROMPT_EN,
      },
      {
        title: "Let it iterate, and spot-check the work",
        body: "The assistant will score, revise, re-score, and report back round by round. Read its before-and-after numbers rather than taking its word for an improvement, and skim a handful of individual answers yourself. One honest catch: when the same assistant both rewrites the prompt and scores the result, its own scoring tends to drift generous over time. Keep the criteria fixed and spot-check a few answers by hand every couple of rounds to catch that early.",
      },
      {
        title: "Repeat until the wins stop, and know the real cost",
        body: "Most prompts have a handful of genuine improvements left in them, then further rounds stop moving the score. That's the signal to stop, not a fixed count. Budget honestly for the time: one full round, scoring, a revision, re-scoring, and a spot-check, tends to run twenty minutes to an hour by hand, so five or six rounds is a real afternoon, not a quick fix.",
      },
    ],
    howBaseline: [
      {
        feature: "Frozen Instances",
        body: "Your 10 to 20 test cases become a set of Instances that stay locked for the whole run, the same discipline you were holding by hand, applied automatically every time.",
      },
      {
        feature: "Rubric-based judging",
        body: "Your written criteria become a Rubric, so every attempt is scored the same way by the same standard, with no spreadsheet cell to fill in yourself.",
      },
      {
        feature: "An Optimization Run explores many at once",
        body: "Instead of one focused revision per round, an Optimization Run tries many prompt versions in parallel against the same Rubric and keeps only the ones that measurably score higher.",
      },
      {
        feature: "An afternoon becomes minutes",
        body: "The whole search, revise and score, runs unattended in the background while your team does something else, and reports back with the winning prompt and the proof.",
      },
    ],
    closingLink: {
      label: "See how Baseline automates this loop",
      href: "/prompt-optimization",
    },
    outcomes: [
      "Get a measurably better prompt this week, using tools you already have.",
      "Turn a vague sense of \"better\" into a written score you can defend.",
      "Learn exactly when to stop tuning by hand and let a search take over.",
      "Walk into an automated run already fluent in the loop it's running for you.",
    ],
    faqs: [
      {
        question: "Can ChatGPT or Claude actually improve a prompt?",
        answer:
          "Yes, for the mechanical part. A capable assistant can score a set of outputs against fixed criteria, spot the biggest recurring problem, and rewrite the prompt to fix it, round after round. What it won't do on its own is stay honest about its own scoring, which is why you keep the test cases and criteria fixed and spot-check its work.",
      },
      {
        question: "How many test cases do I actually need?",
        answer:
          "Fewer real ones beat more made-up ones. 10 to 20 inputs pulled from real usage, covering the cases that actually go wrong, tell you more than 100 synthetic examples invented to look thorough. Realism matters more than volume.",
      },
      {
        question: "How do I know the new prompt is actually better, not just different?",
        answer:
          "Score it against the exact same test cases and the exact same criteria as the original, and write both numbers down. If the total goes up on a fixed measurement, the improvement is real. If you can't point to that comparison, you don't actually know yet.",
      },
      {
        question: "When does manual optimization stop being enough?",
        answer:
          "When you're running the same loop across many prompts, need it to happen on a schedule instead of an afternoon, or want to try more revisions per round than you can score by hand. That's when an Optimization Run in Baseline picks up the exact loop above and runs it unattended, at a scale a spreadsheet can't keep up with.",
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
