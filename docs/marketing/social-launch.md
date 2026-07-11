# Social launch: persona and first six posts

Pseudonymous social strategy for Baseline's invite-only launch phase. The companion
attribution conventions (UTMs, per-post access codes, PostHog dashboard) live in
`docs/marketing/social-attribution.md`.

**Hard rule: pseudonymous, not undisclosed.** The persona hides the operator's
identity, never the affiliation. The bio always states that the account is building
Baseline. Promoting the product from an account that pretends to be an unaffiliated
user is astroturfing (FTC material-connection disclosure applies) and is the fastest
way to burn the account's credibility if discovered.

## The persona

**Sam @ Baseline** (handle: **@rubricsam**)

- First-name-only. No surname, no invented backstory, no AI-generated face
  (reverse-image-searchable and radioactive when caught).
- Avatar: abstract cobalt mark (the brand accent) on the cream paper background.
- Banner: the Score lift card from a completed Optimization Run (74% to 86%,
  +12pp), cropped from `public/docs/optimization-run.png` — the lead sell in the
  profile header.

**Bio (X):**

> Building Baseline. Prompt optimization with proof: rewrites scored against your
> rubric, keep what measurably wins. I post score deltas and eval failures. Invite
> codes drop here.

### Voice rules (Sam's style guide)

- Plain language for a non-technical buyer; glossary vocabulary (Rubric, Eval Run,
  Schedule, Optimization Run) over jargon.
- Numbers over adjectives. Every post carries one concrete artifact: a screenshot
  sequence, a score delta, a worked calculation.
- **The lead sell is optimization**: a measurably better prompt, proof attached.
  The recurring stance underneath it is **"one definition of good"** — the rubric is
  why the delta can be trusted, so rubric/judge content plays support, never lead.
- Plain honesty about limits: optimization spends scored calls, budgets are real,
  and a delta on a five-row test set proves less than one on fifty.
- Generous by default: full walkthroughs, including the DIY-without-Baseline version.
- Never names competitors in posts. The `/compare/*` pages do that job later, once
  the account has standing.
- Copy rules match the product voice: no em dashes, lead positive, no
  negate-then-correct phrasings.

### Channels

- **X** — primary. Pseudonymous is native here. 3 posts/week (Mon/Wed/Fri).
- **LinkedIn** — secondary, as the Baseline company page only. LinkedIn enforces
  real-name policies on personal profiles, so the persona cannot safely live there.
  The company page reposts the same material in a slightly more formal register,
  1–2/week.
- **Reddit / HN** — reply-only mode. Answer eval questions in r/LLMDevs and similar,
  link a guide only when it is the honest answer to the question. Never submit our
  own marketing pages to HN.

## Posting mechanics

- Links go in the **first reply**, never the post body (X downranks link posts).
- Every link carries UTMs per `social-attribution.md`; the campaign slug is dated,
  e.g. `2026-07-15-simple-mode-delta`.
- Each code drop mints a dedicated access code (`npm run access-codes:mint`) with a
  small `max_redemptions` cap and a short expiry. The code name pairs with the
  campaign slug so redemptions attribute per post without consent-gated analytics.
  Codes ride the two carousel posts (2 and 4).
- Rotation after the first six: optimization stays the lead. Cycle
  delta / step-by-step / guide-serialization / code drop through the remaining
  category guides, with eval and rubric content in the support slots. Comparison
  pages come later, once the account has standing.

## Screenshots (no video)

Posts use the guide screenshots in `public/docs/` (2880x1800, captured from a clean
demo Team, already free of identity leaks) instead of screen recordings. Each guide
page's step sequence maps directly onto an X post: up to 4 images per post, attached
in step order, with the step numbers carried in the post text.

- Reuse across posts is fine; the guides themselves share screenshots. The captions,
  not the pixels, carry each post's angle.
- Give every image X alt text (copy or adapt the step's `alt` prose from
  `src/lib/marketing/categories.ts`).
- If a new surface needs capturing later, match the existing set: 2880x1800, clean
  browser profile, neutral demo Team name, notifications off.

## The first six posts

Cadence starts Monday 2026-07-13. The arc: lead with the sell (a measurably better
prompt), spend the middle earning trust in the score behind it (rubric, judge), and
close on pricing transparency.

### 1 — Mon Jul 13 · Stance post (pin this)

Campaign: `2026-07-13-measured-search` · Link: `/prompt-optimization`

> Most teams improve prompts by hand: change a sentence, eyeball a few outputs, ship
> whatever feels better. "Feels better" is a guess wearing a decision's clothes.
>
> I'm building Baseline to make prompt improvement a measured search. It generates
> rewrites, scores each one against a rubric your team wrote, and keeps what
> measurably wins.
>
> I'll post real optimization runs, score deltas, and the failures that surprise me.
> Invite codes drop here too.

Image: `optimization-run.png` (a finished Optimization Run with the before/after
score delta: the sell in one frame).

Reply 1: link with UTMs, e.g.
`/prompt-optimization?utm_source=x&utm_medium=social&utm_campaign=2026-07-13-measured-search`

### 2 — Wed Jul 15 · Step-by-step: a tournament of rewrites

Campaign: `2026-07-15-simple-mode-delta` · Code: `OPTIMIZE10` (cap 10, 3-day
expiry) · Link: `/simple-prompt-optimization`

> A prompt optimization run is a tournament of rewrites. Each round, every candidate
> starts from a current best prompt and rewrites it one way: add a worked example,
> restructure as numbered steps, tighten it. Every candidate is scored on the same
> frozen inputs by the same rubric.
>
> Four steps, start to finish:
>
> 1. Paste the prompt
> 2. Add a handful of real test inputs
> 3. Pick your budget (the one real decision)
> 4. Take the winner, proof attached

Images (in order, the simple-prompt-optimization guide's wizard sequence):
`optimization-wizard-system-simple.png`, `optimization-wizard-instances.png`,
`optimization-wizard-tuning.png`, `optimization-run.png` — the last one shows the
before/after score delta, which is the payoff frame.

Reply 1: "First invite drop: code OPTIMIZE10, first 10 people, expires Friday."
Reply 2: the guide link with UTMs.

### 3 — Fri Jul 17 · The generous DIY post

Campaign: `2026-07-17-manual-loop` · Link: `/manual-prompt-optimization`

> You can make a prompt meaningfully better this afternoon without buying anything.
>
> 1. Freeze a real test set so the ground never shifts.
> 2. Write down the criteria you're judging by.
> 3. Change exactly one thing.
> 4. Re-score against the same cases and criteria.
> 5. Keep the change only when the total goes up.
>
> Most prompts improve noticeably in a handful of rounds. The real cost is your time,
> and knowing exactly when that cost stops being worth it.

No images: the numbered list is the artifact, and this post deliberately shows no
product. It reinforces the lead sell by teaching the same loop the product
automates. Reply 1: the full guide link. This is the trust-builder; it sells
nothing and the guide itself closes to the automated path.

### 4 — Mon Jul 20 · Step-by-step: where the score comes from

Campaign: `2026-07-20-rubric-steps` · Code: `RUBRIC10` (cap 10, 3-day expiry) ·
Link: `/rubric-based-evaluation`

> Every score delta I post is measured against a rubric. Here's what that actually
> means.
>
> Ask three people whether an AI answer is good and you'll get three answers. One
> cares about accuracy, one about tone, one about length. A rubric ends the
> argument: weighted criteria, written down once, and every output scored against
> the same definition.
>
> The whole loop in 4 steps:
>
> 1. Write down what good looks like
> 2. Run your outputs against it
> 3. Read the score per row, per criterion
> 4. Watch the trend over time

Images (in order, one per step, alt text from the guide steps):
`rubric-editor.png`, `rubrics-runs-panel.png`, `eval-run-detail.png`,
`dashboard-score-trend.png` — the llm-evaluation guide's walkthrough sequence.

Reply 1: "Second invite drop: code RUBRIC10, first 10 people, expires Thursday."
Reply 2: the guide link with UTMs.

### 5 — Wed Jul 22 · Thread: LLM-as-a-judge

Campaign: `2026-07-22-judge-thread` · Link: `/llm-as-judge` (`utm_content=thread-t6`)

> **1/** When I post a score delta, the obvious question is: who graded the outputs?
> Human review is the gold standard, and it caps out fast: slow, expensive,
> inconsistent between reviewers. Most teams check a tiny sample and hope. Here's
> how to scale it.
>
> **2/** LLM-as-a-judge: a strong model reads each output and scores it the way a
> trained reviewer would, in seconds, at any volume.
>
> **3/** The catch is trust. An ungrounded grader is just another opinion. You get a
> number with no idea why, and no two runs agree.
>
> **4/** The fix is anchoring the judge to a rubric your team wrote. Named criteria,
> weights, scoring steps. The judge stops improvising and starts applying your
> standard.
> [image: `rubric-editor-criteria.png`]
>
> **5/** Now scores are consistent and reviewable. When one looks wrong, you check
> which criterion moved and argue with a written document instead of a vibe.
> [image: `eval-run-detail.png` — per-criterion scores with the judge's reasoning]
>
> **6/** Full walkthrough, including where a human still belongs in the loop: [link]

### 6 — Fri Jul 24 · Pricing transparency

Campaign: `2026-07-24-eval-points` · Link: `/ai-eval-pricing`

> Our pricing is arithmetic you can check before you spend anything.
>
> Every row in an eval run costs 10 points of orchestration plus 5 points per
> criterion scored. A 3-criteria rubric is 25 points per row, so a 100-row run costs
> exactly 2,500 points.
>
> Token costs sit on a separate meter, and when you bring your own API key that
> meter reads zero. The run dialog does the math before you confirm.

Images: `eval-run-dialog-points.png` (the run dialog doing the arithmetic before
you confirm), `billing-eval-points.png` (the allowance and ledger) — the
ai-eval-pricing guide's pair.

Reply 1: the pricing guide link with UTMs.
