import type { AppLocale } from "@/i18n/routing";

/**
 * The `/blog` narrative-content surface (#435): a simple index + `/blog/{slug}`
 * post route on the same lander machinery as the category/comparison surfaces
 * (typed data file, shared renderer, colocated OG image, sitemap pickup). Simple
 * means simple, by design: no tags, no authors, no RSS, no comments, no
 * pagination — those get added if/when there are enough posts to need them.
 *
 * A post's body is a list of `PostSection`s, each an H2 heading plus an ordered
 * list of `PostBlock`s (paragraph, list, table, pre, image) — the structural
 * shapes the first post's case-study content actually needs. `PostSegment` lets a
 * paragraph/list item mix plain text with a bold run or an internal link inline,
 * without reaching for a full markdown renderer.
 */

/** One inline run within a paragraph or list item. */
export type PostSegment =
  | string
  | {
      text: string;
      /** Emphasize this run, e.g. a headline score. */
      strong?: boolean;
      /** Internal app path this run links to, e.g. "/prompt-optimization". */
      href?: string;
    };

export interface PostTableBlock {
  kind: "table";
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface PostPreBlock {
  kind: "pre";
  /** Rendered as a preformatted code/prompt block. */
  text: string;
  /** Optional label above the block, e.g. "Before" / "After". */
  label?: string;
}

export interface PostImageBlock {
  kind: "image";
  /** Static asset path under `public/`, e.g. "/docs/blog-optimizer-run.png". */
  src: string;
  alt: string;
  width: number;
  height: number;
}

export interface PostVideoBlock {
  kind: "video";
  /** YouTube video id, e.g. "ueNWzKoBEd8". Rendered as a privacy-enhanced
   * youtube-nocookie.com embed (no cookies until the visitor presses play,
   * consistent with the opt-in consent posture) — the host is allow-listed in
   * `src/lib/security/csp.ts`'s frame-src. */
  videoId: string;
  /** Accessible iframe title; also the JSON-LD VideoObject name. */
  title: string;
}

export interface PostParagraphBlock {
  kind: "paragraph";
  segments: readonly PostSegment[];
}

export interface PostListBlock {
  kind: "list";
  ordered: boolean;
  items: readonly (readonly PostSegment[])[];
}

export type PostBlock =
  | PostParagraphBlock
  | PostListBlock
  | PostTableBlock
  | PostPreBlock
  | PostImageBlock
  | PostVideoBlock;

/** One `##` section of the post body: a heading plus its content blocks. */
export interface PostSection {
  heading: string;
  blocks: readonly PostBlock[];
}

export interface Post {
  /** Flat URL slug: `/blog/{slug}`. */
  slug: string;
  /**
   * The set of locales this post exists in (ADR-0013). The first post ships
   * `["en"]`; es/fr are a fast-follow, added the same way the category pages
   * widened theirs once a translation lands.
   */
  locales: readonly AppLocale[];
  /** ISO date (`YYYY-MM-DD`) the post was published. Drives sort order + the
   * on-page byline + the sitemap/JSON-LD `datePublished`. */
  publishedAt: string;
  /** `<title>` and OG/Twitter title. */
  metaTitle: string;
  metaDescription: string;
  /** On-page H1. */
  heading: string;
  /** Subtitle rendered into the dynamic OG card under the post title. */
  ogSubtitle: string;
  /** Card/list-page description (index listing, JSON-LD `description`). */
  description: string;
  /**
   * Opening paragraph(s), rendered before the first `##` section. Each
   * paragraph is a segment list — the same shape as a body paragraph — so the
   * dek can carry inline links and emphasis too.
   */
  dek: readonly (readonly PostSegment[])[];
  /** The body, section by section. */
  sections: readonly PostSection[];
}

// Helper so a plain string paragraph doesn't need `{ kind: "paragraph", segments: [...] }`
// boilerplate at every call site below.
function p(...segments: readonly PostSegment[]): PostParagraphBlock {
  return { kind: "paragraph", segments };
}

const OPTIMIZER_DOGFOOD_ORIGINAL_PROMPT = [
  "You are helping me manually improve an AI prompt through structured rounds of testing and revision. Here is how to run this with me:",
  "",
  "1. Ask me for three things if I haven't already given them: my current prompt, a set of 10 to 20 real test cases (each one an input, plus either an expected output or a plain description of what a good answer looks like), and the criteria I'll judge answers by. If anything is missing, help me build it before we start: draft test cases from examples I give you, or draft criteria from a description of what \"good\" means for my use case.",
  "2. Run the current prompt against every test case (or ask me to paste in real outputs if you can't run the prompt yourself), and score each one against the criteria. Write the scores down in a simple table so we have a clear starting point.",
  "3. Look across every scored case and name the single failure pattern that shows up most often. Not every small issue, just the one costing the most points across the whole set.",
  "4. Make exactly one focused change to the prompt that targets that pattern. Don't rewrite the whole prompt, and don't fix five things at once.",
  "5. Score the revised prompt against the exact same test cases and the exact same criteria.",
  "6. Compare the new total to the previous round. If it improved, keep the revision and go back to step 3. If it didn't, revert to the previous best prompt and try a different angle on the same failure pattern.",
  "7. Repeat steps 3 through 6. Stop after 5 rounds, or after 2 rounds in a row with no improvement, whichever comes first.",
  "8. When you stop, give me: the final prompt in full, a table showing the score before and after for every test case, and a short, plain-language summary of what changed and why it helped.",
  "",
  "Two rules for the whole run: never change the test cases once we start, and judge every change by what it does to the whole set, never by whether it fixes one favorite case at the expense of the others.",
].join("\n");

const OPTIMIZER_DOGFOOD_REVISED_PROMPT = [
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

// Single source of truth. The surface grows by appending here, the same way
// CATEGORIES/COMPARISONS do.
export const POSTS = [
  {
    slug: "optimizer-prompt-dogfood",
    locales: ["en"],
    publishedAt: "2026-07-06",
    metaTitle:
      "We ran Baseline on our own advice, and the advice got 28 points better | Baseline",
    metaDescription:
      "We pointed an Optimization Run at the copy-paste prompt from our own manual-optimization guide. Full before/after numbers, the winning prompt, and what the experiment does and doesn't prove.",
    heading:
      "We ran Baseline on our own advice, and the advice got 28 points better",
    ogSubtitle: "A real before/after, run on our own prompt.",
    description:
      "We pointed Baseline's Optimization Run at the copy-paste prompt from our own manual-optimization guide. Here's the full experiment, numbers included, warts included.",
    dek: [
      [
        "Our manual ",
        { text: "guide", href: "/manual-prompt-optimization" },
        " shows how to improve prompts by hand: freeze a small set of test cases, score your prompt against written criteria, then hand the revision loop to an AI assistant with a single copy-paste prompt. The guide ends by noting that Baseline automates that loop. Which raised an obvious question we couldn't resist: what happens if we point Baseline at the copy-paste prompt itself?",
      ],
      ["So we did. This is the full experiment, numbers included, warts included."],
    ],
    sections: [
      {
        heading: "The setup",
        blocks: [
          p(
            "The subject was the exact prompt from our manual guide. It instructs an assistant to score a flawed prompt against test cases, find the biggest recurring failure, make one focused revision, re-score, and repeat until the wins stop."
          ),
          p(
            'To evaluate it, we built ten realistic "prompt improvement jobs." Each one bundles a deliberately flawed prompt (a changelog summarizer that drifts into marketing hype, a support reply drafter that promises refunds its policy forbids, a SQL writer with no guardrails), plus five test cases and scoring criteria. Every flaw is the kind you meet in real work: a missing length cap, no rule for absent data, an instruction that quietly fights the criteria.'
          ),
          p(
            "Then we wrote a Rubric with five weighted criteria, each one checkable from the transcript alone: did it use only the given test cases, did it name one grounded failure pattern per round, did it make one focused change at a time, did it deliver the full report, and do its numbers add up."
          ),
        ],
      },
      {
        heading: "The baseline: 0.637, with a visible weakness",
        blocks: [
          p(
            "We ran an Eval Run scoring the original prompt's transcripts across all ten jobs. Overall score: ",
            { text: "0.637", strong: true },
            "."
          ),
          p(
            "The breakdown told a story. Three of the ten transcripts scored between 0.15 and 0.20, and they all failed the same way: instead of running the loop, the assistant stopped and asked us to paste in outputs. The original prompt contains a polite escape hatch (\"or ask me to paste in real outputs if you can't run the prompt yourself\"), and in a single-completion setting that hatch swallows the whole job. Diagnosis quality was the weakest criterion overall at 0.580."
          ),
          p(
            "That's the kind of pattern you'd eventually spot by hand. The point of the experiment was to see whether the machine would spot it, and what it would do about it."
          ),
        ],
      },
      {
        heading: "The Optimization Run: six minutes, unattended",
        blocks: [
          p(
            "We created a Managed Agent whose prompt was the guide's prompt, seeded the run's frozen inputs straight from the baseline Eval Run, chose Reflective Mode, and gave it a budget of 40 scored test runs. Then we got coffee. Total wall-clock time: about six minutes."
          ),
          {
            kind: "image",
            src: "/docs/blog-optimizer-run.png",
            alt: "The completed Optimization Run: score lift from 54% to 78%, a 24 point gain, with the run's configuration",
            width: 1280,
            height: 577,
          },
          p(
            "The optimizer's job is to read the Rubric's written reasoning about what failed and propose focused revisions. Across its iterations it found three changes:"
          ),
          {
            kind: "list",
            ordered: true,
            items: [
              [
                { text: "A proceed-immediately rule.", strong: true },
                ' A new instruction: once the prompt, cases, and criteria are present, go straight to scoring. "Do not ask for more test cases, do not request numeric weights. Work with exactly what you have been given." This directly kills the stall that sank three baseline jobs.',
              ],
              [
                { text: "Score by reasoning, always.", strong: true },
                " The escape hatch is gone. The revised prompt says to reason through what the prompt would likely produce for each case and score that, which keeps the loop self-sufficient.",
              ],
              [
                { text: "Deliver everything, unprompted.", strong: true },
                ' The final report step now reads "deliver all three of the following without waiting to be asked," closing the gap where a transcript ended before the score table appeared.',
              ],
            ],
          },
          p(
            "Notice what those three changes have in common: they are exactly the fixes a careful human would make after reading the failing transcripts. The optimizer just read them first."
          ),
        ],
      },
      {
        heading: "The confirmation: 0.637 → 0.919",
        blocks: [
          p(
            "Optimizers grade their own homework, so we don't use their internal scores as the headline. Instead we ran a second Eval Run with the revised prompt on the same ten jobs, judged by the same Rubric. Same instrument, before and after."
          ),
          {
            kind: "image",
            src: "/docs/blog-eval-runs.png",
            alt: "The rubric's Eval Runs panel: the baseline run at 64% and the confirmation run at 92%",
            width: 1280,
            height: 577,
          },
          {
            kind: "table",
            headers: ["Criterion", "Before", "After", "Change"],
            rows: [
              ["Diagnosis quality", "0.580", "0.926", "+0.346"],
              ["Report completeness", "0.604", "0.950", "+0.346"],
              ["Contract compliance", "0.645", "0.947", "+0.302"],
              ["Scoring honesty", "0.671", "0.926", "+0.255"],
              ["Revision discipline", "0.682", "0.840", "+0.158"],
              ["Overall", "0.637", "0.919", "+0.282"],
            ],
          },
          p(
            "The stalls vanished entirely. Every revised transcript runs the full loop and ends with a complete report."
          ),
        ],
      },
      {
        heading: "The prompts, before and after",
        blocks: [
          p(
            "Judge for yourself. The original, as first published in the guide:"
          ),
          {
            kind: "pre",
            label: "Before",
            text: OPTIMIZER_DOGFOOD_ORIGINAL_PROMPT,
          },
          p("And the optimized version, the one the guide now carries:"),
          {
            kind: "pre",
            label: "After",
            text: OPTIMIZER_DOGFOOD_REVISED_PROMPT,
          },
          p(
            "One disclosure: we made two cosmetic edits to the winner before shipping it, for house style. Neither touches the behavior."
          ),
        ],
      },
      {
        heading: "What this does and doesn't prove",
        blocks: [
          p(
            "Ten jobs, one Rubric, one run. This proves the loop works end to end and that the revised prompt is measurably better on these jobs, judged by these criteria. It doesn't prove the revised prompt is better for every task you'll ever throw at it, and an LLM judge scores transcripts, not ground truth. We'd make the same caveat about any eval this size, including yours."
          ),
          p(
            "What it demonstrates cleanly is the trade the product makes: the manual loop from our guide costs you an afternoon per round of careful reading and revising. The Optimization Run spent 40 scored attempts and six unattended minutes to find what three afternoons of squinting at transcripts would have found."
          ),
        ],
      },
      {
        heading: "Try either path",
        blocks: [
          p(
            "The manual guide, carrying the improved prompt, is at ",
            {
              text: "/manual-prompt-optimization",
              href: "/manual-prompt-optimization",
            },
            ". It genuinely works with nothing but a spreadsheet and a chat window."
          ),
          p(
            "And when you'd rather spend the afternoon on something else, ",
            { text: "/prompt-optimization", href: "/prompt-optimization" },
            " is the automated loop, the same one we pointed at ourselves."
          ),
        ],
      },
    ],
  },
  {
    slug: "baseline-on-youtube",
    locales: ["en"],
    publishedAt: "2026-07-21",
    metaTitle: "Baseline is on YouTube: watch the optimization loop run | Baseline",
    metaDescription:
      "Our first video runs the measured prompt-optimization loop end to end: real test cases, honest scores, and a lift from 80% to 98%. Watch it, then follow the build on YouTube and X.",
    heading: "Baseline is on YouTube: watch the optimization loop run",
    ogSubtitle: "The measured optimization loop, on video.",
    description:
      "Our first video runs the measured prompt-optimization loop end to end, from an 80% baseline to 98%, with every score on screen. Here's what it covers and where to follow along.",
    dek: [
      [
        "Reading about an optimization loop is one thing. Watching one run is better. We started a YouTube channel to show the loop the way it actually happens: real prompts, frozen test cases, honest scores, and rounds that get discarded when the numbers say so.",
      ],
      ["The first video is live, and it carries the whole method in one sitting."],
    ],
    sections: [
      {
        heading: "The first video: 80% to 98%, with the receipts",
        blocks: [
          {
            kind: "video",
            videoId: "ueNWzKoBEd8",
            title:
              "Prompt optimization with proof: 80% \u2192 98% with LangChain evals + Claude Code",
          },
          p(
            "The video runs the loop from our ",
            { text: "manual guide", href: "/manual-prompt-optimization" },
            " end to end on a real prompt. It starts from an 80% baseline against a frozen set of test cases, works through measured revision rounds with LangChain evals and Claude Code, and ends at 98% with every score shown as it lands. Nothing is trimmed to look tidy: when a revision moves the number the wrong way, it gets reverted on camera."
          ),
          p(
            "The whole first half runs on free tools you can set up this afternoon, and everything it uses lives in the public ",
            {
              text: "demo repo",
              href: "https://github.com/baselinelabai/prompt-optimization",
            },
            ": the prompt, the test cases, the eval harness, and the run logs. The second half rebuilds the same loop inside ",
            { text: "Baseline", href: "/prompt-optimization" },
            ", where the frozen set, the scoring, and the revision rounds run as one Optimization Run while you do something else."
          ),
        ],
      },
      {
        heading: "Where to follow the build",
        blocks: [
          {
            kind: "list",
            ordered: false,
            items: [
              [
                { text: "YouTube", strong: true },
                ": subscribe to ",
                {
                  text: "the Baseline channel",
                  href: "https://www.youtube.com/@Baseline-u4g",
                },
                " for more runs in the same format: one claim, one measured loop, numbers on screen.",
              ],
              [
                { text: "X", strong: true },
                ": ",
                { text: "@baselinesam", href: "https://x.com/baselinesam" },
                " posts short build-in-public updates between videos: what shipped, what broke, and what the numbers said.",
              ],
              [
                { text: "The guides", strong: true },
                ": the ",
                {
                  text: "manual loop",
                  href: "/manual-prompt-optimization",
                },
                " works with nothing but a spreadsheet and a chat window, and ",
                { text: "the automated version", href: "/prompt-optimization" },
                " is the product.",
              ],
            ],
          },
          p(
            "If you watch the video and try the loop on one of your own prompts, tell us how it went. The honest runs, including the ones that stall, are exactly what the next videos are made of."
          ),
        ],
      },
    ],
  },
] as const satisfies readonly Post[];

/** Every post slug, derived from the single source (no duplicated list). */
export const POST_SLUGS = POSTS.map((p) => p.slug);

/**
 * Look up a post by slug. Unlike `getCategory`/`getComparison`, there is no
 * per-locale translation overlay yet: every shipped post is `locales: ["en"]`
 * today, so the route's locale-set guard is what keeps es/fr requests 404ing
 * until a translation actually lands (ADR-0013).
 */
export function getPost(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
}

/** All posts, newest first — the order the index page lists them in. */
export function postsNewestFirst(): readonly Post[] {
  return [...POSTS].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}
