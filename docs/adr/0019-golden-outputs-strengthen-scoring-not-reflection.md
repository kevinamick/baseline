# Golden Outputs strengthen optimization scoring, never Reflection

An Instance's optional `expected_output` becomes a **Golden Output** inside an
Optimization Run: when present, the judge scores a Candidate's output against it as an
authoritative example of a perfect response — **outcome-equivalence** ("does this output
achieve what the golden output achieves"), never textual similarity. The strengthening is
a property of how optimization *uses* the field, not of the data: no new entity, no new
column, no per-row flag, no per-run toggle, and Eval Runs keep the field's existing loose
"optional context for the judge" semantics. Reflection deliberately does **not** see raw
golden outputs — it keeps reading only the judge's natural-language reasoning, which is
now golden-informed.

The Reflection exclusion is the headline decision, because a future contributor will look
at it and see an obvious improvement to make: feed the golden output straight into the
Reflection prompt so the proposer can close the gap deliberately. Don't. The frozen
Instance set is simultaneously the training set and the selection set — there is no
holdout — so a proposer that can read raw golden text has a cheapest path to a higher
score: bake instance-specific answers into the prompt itself. That scores perfectly on
the frozen set and generalizes badly, which is the one failure mode that makes users
conclude prompt optimization is snake oil. Routing the signal through the judge's
reasoning ("the output omitted the refund-policy caveat a perfect answer includes")
passes the gap forward without handing over copyable text. If indirect guidance proves
too weak, adding direct visibility later is a reversible experiment; un-burning users
who shipped overfit prompts is not.

## Status

Accepted.

## Considered options

**A first-class Golden Data Set entity (rejected).** A Team-owned, curated, reusable
set of input→perfect-output pairs with its own table and library UI. Rejected as the
first slice: the thing that changes optimization outcomes is how golden outputs guide
the loop, and that is provable end-to-end with the existing `expected_output` field and
existing intake (manual/CSV/JSON, Eval Run seed, PostHog dataset snapshot). A reusable
library can layer on later as just another intake source.

**A synthetic "fidelity to golden" criterion (rejected).** Auto-appending a weighted
criterion cleanly separates the signal but mutates the effective Rubric, adds a
dimension to the per-instance score vector Pareto selection runs on, and silently
changes billing — ADR-0016 prices runs at `points = rollouts × (10 + 5×|criteria|)`.
Instead the golden framing goes inside each existing criterion's judge prompt: the
Rubric still defines what matters; the golden output shows what perfect looks like.

**Textual-similarity scoring (rejected).** Embedding or string similarity is cheap per
rollout, but golden outputs here are prose whose *outcome* matters. A candidate that
covers the same facts in a different format should score well; punishing format
divergence the Rubric doesn't ask about teaches the optimizer to parrot. Same reason
the judge-prompt wording must say "achieves the same outcome," never "matches."

**All-or-nothing golden coverage per run (rejected).** Requiring every Instance to
carry a golden output before any gets the strong framing looks like scoring
consistency, but Pareto selection compares Candidates per instance — a stricter bar on
some instances applies equally to every Candidate and cancels out. Mixed sets are
normal and give users an adoption ramp (golden your five most important instances
first). Accepted consequence: scores are not comparable across runs with different
golden coverage on the same Rubric — consistent with scores already not being
comparable across Rubric edits.

## Consequences

- **Judge seam.** `rolloutCandidate` scores through the same `evaluateRun` as the eval
  path, so the strong framing branches on the optimization context there — Eval Runs
  are byte-for-byte unchanged.
- **Simple Mode rides along.** It has no Reflection, so it gets the judge upgrade only;
  coherent, since Simple is score-driven and the score is now golden-aware.
- **Intake.** Manual/CSV/JSON, Eval Run seed, and PostHog snapshots already populate
  `expected_output`. The custom dataset adapter's `FieldMap` hardcodes it to null —
  deliberately deferred as a separate small issue, and low-value here anyway: dataset
  connections carry noisy historical logs, while hand-curated files are the natural
  home of perfect outputs.
- **Vocabulary.** "Golden Output" is internal (CONTEXT.md, code, this ADR). Every
  user-facing surface keeps calling the field "expected output" — one field, one name.
  UI in the first slice is a coverage line in the wizard review step and on run detail.
