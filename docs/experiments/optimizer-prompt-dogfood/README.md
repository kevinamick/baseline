# Dogfood experiment: optimize the manual guide's optimizer prompt

Run Baseline's Optimization Run against **P** — the copy-paste optimizer prompt shipped
on `/manual-prompt-optimization` (PR #433, `MANUAL_LOOP_PROMPT_EN` in
`src/lib/marketing/categories.ts`). Baseline does to P what P does to prompts. The
outcome feeds two things: a better published prompt, and a case-study guide with real
before/after numbers.

## The mapping

| Baseline concept | This experiment |
|---|---|
| Managed Agent Module prompt | P (the guide's optimizer prompt, v1) |
| Instance / Eval Run Row input | one "prompt-optimization job": a flaky prompt + its test cases + its criteria (`instances.md`, 10 jobs) |
| Rubric | "Prompt Optimizer Quality" (`rubric.md`, 5 criteria) |
| Eval Run on the Managed Agent | the baseline score for P |
| Optimization Run (Reflective) | the dogfood: evolving P |

Two design constraints baked into the drafts:

- **One-shot compression.** P is written for a multi-turn chat; a Managed Agent
  invocation is a single completion. Every Instance therefore carries all three inputs
  P demands, so its "help me build the missing pieces" branch never triggers, and the
  loop compresses into one long response. If the optimizer learns P needs an explicit
  "you have everything, do not ask questions" line, that is itself a publishable finding.
- **Judge the artifact, not ground truth.** The judge cannot execute the revised
  prompts P produces, so every Rubric criterion is verifiable from the transcript
  alone (contract compliance, diagnosis grounding, revision discipline, report
  completeness, scoring consistency).

## Runbook

Environment: **staging** (Team on a paid plan; BYO Anthropic key recommended so the
run does not draw on the Managed Spend Cap).

1. **Create the Rubric** from `rubric.md` (5 criteria, weights as listed, steps pasted
   per criterion). Scale plan caps are 15/15, so it fits any paid tier's editor caps.
2. **Create the Managed Agent Connection** ("Optimizer Prompt P") with P v1 pasted as
   its single Module prompt, verbatim from the guide entry.
3. **Baseline Eval Run**: create an Eval Run against that Connection with the 10 rows
   from `instances.md` (each row: the packaged job as user input; the "what good looks
   like" note as expected output). Record the overall score — this is the case study's
   "before."
4. **Sanity-check the judge** on 2-3 scored rows before spending real budget: read the
   judge reasoning against the transcript. If it credits contract compliance the
   transcript doesn't show, tighten the criterion steps first.
5. **Optimization Run**, seeded from that Eval Run (#421 intake), **Reflective Mode**
   (this Rubric is exactly the demanding, feedback-rich case the guide says Reflective
   is for). Start with a small sanity budget (~40 rollouts), review the first
   iterations, then the real run (~200 rollouts, the Builder ceiling).
6. **Review the winning Candidate P′**: read the diff against P v1; run the
   vocabulary-firewall test mentally and then literally (see step 8) — the optimizer
   does not know the lexicon rules (no GEPA/Reflection/Candidate/Rollout/Module/
   Pareto/mutation/crossover) and may introduce banned terms or chat-only phrasing
   that reads wrong on a marketing page.
7. **Confirm with a second Eval Run**: same 10 rows, Managed Agent updated to P′. This
   is the case study's "after" on the same instrument as the "before" (the optimizer's
   internal scores are not the headline numbers; the paired Eval Runs are).
8. **Ship**: replace `MANUAL_LOOP_PROMPT_EN` (and re-translate es/fr) in a PR — the
   firewall test in `categories.test.ts` gates it — and capture for the case study:
   baseline score, final score, per-criterion movement, the P v1→P′ diff, rollouts
   spent, and wall-clock time vs the manual loop's per-round cost.

## What NOT to conclude

A one-Rubric, 10-Instance experiment proves the loop works end to end and yields a
defensible before/after for these jobs. It does not prove P′ is better for every
reader's task — the case study should say so plainly (the honesty is on-brand for the
manual guide it links back to).

## Results log

- **Baseline (P v1)** — local develop, Team C, 2026-07-06. Eval run
  `ce1098e7-957c-4f69-b3de-31c8344f9478` (10 rows, outputs generated with
  `claude-sonnet-4-6` + P v1 as system prompt): **overall 0.637**.
  Per-criterion averages: Diagnosis quality 0.580, Report completeness 0.604,
  Contract compliance 0.645, Scoring honesty 0.671, Revision discipline 0.682.
  Three transcripts (field extractor, meeting-notes extractor, blog titles)
  scored ~0.15-0.20: P stopped to ask for pasted outputs instead of running the
  loop — the predicted one-shot weakness, now measured. Rubric
  `8f0dc593-6042-4bb3-b936-ba7a7583a90f`, Managed Agent connection
  `aae0348a-9004-46d8-b5f8-bbf5ed4489ed` ("Optimizer Prompt P (dogfood)").

- **Optimization Run** — `6fe716ed-4477-47cc-8457-11ce9eb47dba`, Reflective,
  40-rollout budget, ~6 min wall clock. Internal seed→best: 0.539 → 0.781
  (+24.2pp). Winning candidate `6439cc71-d476-40ba-8e6f-898a47a8294e` (P′):
  adds a proceed-immediately rule, removes the "paste real outputs" escape
  hatch (score by reasoning), and requires the full three-part report
  unprompted. Firewall-clean (0 banned terms); introduces em dashes that need
  a scrub before shipping in the guide.
- **Confirmation (P′)** — eval run `7a1e05ae-623e-4685-8987-1deaa70c5e55`,
  same 10 jobs, same Rubric: **overall 0.919** (paired lift **+28.2pp**).
  Per-criterion: Diagnosis 0.926, Report completeness 0.950, Contract
  compliance 0.947, Scoring honesty 0.926, Revision discipline 0.840. The
  baseline's stalled transcripts are gone. P′ transcripts:
  `pprime-rows.json`; post draft: `blog-post.md`.
- **Known scoring artifact in the confirmation run:** row 6's Revision
  discipline judgment hit the judge's 1024-token cap mid-JSON and the parser
  scored it 0.000 despite the truncated response beginning `"score": 0.92`
  (#436). The 0.919 overall therefore UNDERSTATES by ~0.018 (true ≈ 0.937,
  Revision discipline ≈ 0.932). Re-run the confirmation after #436 lands for
  clean publication numbers.

## Follow-ups after numbers exist

- Grill the case-study guide (angle, slug, content shape — it is proof-narrative, not
  a how-to lander; needs its own non-cannibalizing angle).
- Decide whether P′ replaces the guide prompt outright or ships alongside the case study.
