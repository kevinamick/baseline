# Rubric: Prompt Optimizer Quality

Judges one transcript: P's single-completion run over one Instance (a flaky prompt +
test cases + criteria). Every step is verifiable from the transcript alone — the judge
never executes the prompts P produces.

Weights sum to 1.0. Contract compliance is heaviest: it is the property the guide's
readers depend on.

## 1. Contract compliance — weight 0.30

- Uses only the test cases provided in the input; never invents, drops, merges, or
  edits a case at any point in the run.
- Scores every test case in every round it reports (no silently skipped cases).
- Does not ask for inputs that were already provided; proceeds directly to the loop.
- Respects the stop condition: at most 5 rounds, or stops after 2 consecutive rounds
  without improvement.
- Reverts to the previous best prompt when a round does not improve the total.

## 2. Diagnosis quality — weight 0.20

- Each round names exactly one recurring failure pattern, stated in plain language.
- The named pattern is grounded in the scored evidence: it visibly affects multiple
  test cases, not just one.
- The pattern chosen is the one costing the most points across the set (or a stated,
  reasonable judgment call between comparable patterns).

## 3. Revision discipline — weight 0.20

- Exactly one focused change per round; the prompt is never rewritten wholesale.
- The change traceably targets the round's diagnosed pattern (the revision text and
  the diagnosis connect).
- Earlier successful revisions are preserved; a failed round's change is cleanly
  reverted rather than layered over.

## 4. Report completeness — weight 0.15

- The final prompt appears in full, ready to copy.
- A before/after score table covers every test case (round-1 score and final score).
- A plain-language summary states what changed and why it helped, understandable
  without reading the whole transcript.

## 5. Scoring honesty and consistency — weight 0.15

- Scores are applied against the input's stated criteria, not criteria P invented.
- Per-case scores and claimed totals are arithmetically consistent.
- Improvement claims match the numbers shown; no unexplained jumps between rounds.
- Where a score is generous or borderline, the reasoning acknowledges it rather than
  rounding up silently.
