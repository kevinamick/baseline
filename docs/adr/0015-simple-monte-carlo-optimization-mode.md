# Simple Mode: a score-only Monte Carlo optimizer, the default for a paste-a-prompt Managed Agent

To optimize a narrow, well-defined prompt (a JSON formatter, a classifier) we add a
second **Optimization Mode** alongside GEPA: **Simple Mode**, a score-only Monte Carlo
search. It seeds with the pasted prompt, and each round generates N rewrite Candidates
from randomly-sampled elites, scores each on the full Instance set, and keeps the
top-k by overall score — concentrating on score alone, with no Reflection. It is
**restricted to paste-a-prompt Managed Agents** (always single-Module) and is the
**default Mode** for them; a Team switches to the **Reflective** Mode (GEPA) when a
Rubric's criteria are nuanced enough to need learning from natural-language feedback.
External agents stay Reflective-only.

The distinction we are selling is *task simplicity*, not cost: a simple task does not
need feedback-driven reasoning, so the cheaper-to-reason-about search is the better fit
and the better default.

## Status

Accepted.

## Considered options

**Unified workflow that branches on Mode (rejected).** One `runOptimizationWorkflow`
reading `mode` and running one of two loop bodies. Rejected on Temporal determinism:
editing the live GEPA workflow risks the replay/versioning of in-flight runs, whereas
registering a brand-new workflow type is inherently safe and leaves GEPA byte-for-byte
unchanged. The expensive logic already lives in Activities both workflows call, so the
duplication avoided is only thin orchestration.

**Strategy-object / pluggable phases (rejected).** Factor the loop into shared
generate/score/select phases with the two Modes as injected strategies. Right if we
expected a third and fourth Mode, but for two it is premature abstraction: the loops
genuinely differ (Pareto frontier + minibatch accept/reject vs. population + elite
selection) and one interface would obscure both.

**Flat one-shot sampling (rejected).** Sample N variants of the seed once, score, return
the best — no rounds, no concentration. The degenerate Monte Carlo case; it underperforms
so badly versus GEPA it would not be worth shipping as a real alternative. We chose
iterative elite-concentration (cross-entropy style), which steers toward optima while
staying free of Reflection.

**Run-local Mode without the connection restriction (rejected).** Offer Simple Mode for
any agent, including external multi-Module ones. Rejected: a score-only method is blind
to credit assignment, so mutating one of several Modules per Candidate and selecting on a
single overall score learns nothing about *which* Module helped. Restricting to the
single-Module Managed Agent sidesteps this entirely and matches the "just paste a prompt"
audience the Mode is for.

## Consequences

- **Architecture.** A separate `runSimpleOptimizationWorkflow` on the existing
  `OPTIMIZATION_TASK_QUEUE`. It reuses `seedRun` / `rolloutCandidate` / `completeRun` /
  `failRun` unchanged and adds one Activity, `proposeSimpleCandidate` (idempotent on the
  `iteration` key — picks a random rewrite operator, calls the generation model, inserts
  the child). `startOptimizationRun` dispatches by Mode. GEPA's workflow is untouched.
- **Guardrails.** Keep the managed-spend-blocked re-throw (Simple runs on the Managed
  Key, so a mid-run cap hit must fail the run, not "complete on the seed") and the plateau
  backstop (redefined as rounds with no gain in the best elite's overall score). Drop the
  endpoint circuit breaker — there is no external endpoint to fail.
- **Schema.** `optimization_runs.mode` from a single const list `["simple","reflective"]`
  (existing rows backfill to `reflective`). A new `'full'` value in the
  `optimization_rollouts.phase` CHECK for Simple's full-set scorings — Simple has no
  minibatch accept/reject step. `iteration` becomes a per-Candidate monotonic sequence
  (Simple makes N Candidates per round, not one per iteration). `generation` = round
  number, `parent_id` = the elite a Candidate was rewritten from.
- **Search control.** Reuse `budget_rollouts` (the hard ceiling), `max_iters` (max
  rounds), and `plateau_patience` — no new termination schema. Population size N and elite
  count k are fixed worker-side constants, never surfaced; the Mode's identity is *fewer
  decisions*.
- **Generation model.** User-selectable and stored in the existing `reflect_model` column
  (functionally "the model that proposes the next prompt"), defaulting to **Haiku 4.5** —
  applying a rewrite operator to a narrow single prompt does not need Sonnet, and Simple
  runs the model far more often than GEPA's one reflection per iteration.
- **Billing.** A Simple run consumes one Optimization Run from the Plan allowance, like
  any Mode. The Managed Spend Cap pre-gate reuses the same reservation/settlement plumbing
  with a Simple-specific estimate bounded by `budget_rollouts`: generation-model tokens per
  Candidate plus judge and target-model tokens per rollout.
- **UI.** The Mode selector sits on the wizard's System step, appearing only for a
  paste-a-prompt Managed Agent and defaulting to Simple. The Tuning step keys its content
  off Mode (Simple shows budget + the generation-model picker + relabeled backstops; N/k
  never appear); Review names the chosen Mode. Final visual design is subject to sign-off.
- **Glossary.** Adds **Optimization Mode** and **Simple Mode**, and scopes **Reflection**
  to a Reflective run ("A Simple Mode run does not reflect"). See `CONTEXT.md`.
