# Optimization loop (GEPA)

Automatically improves an agent's prompts by running it, reading the grader's
natural-language feedback, reflecting on what went wrong, and rewriting the prompt.
Based on **GEPA** — Genetic-Pareto reflective prompt evolution
([arXiv:2507.19457](https://arxiv.org/abs/2507.19457)).

This is the durable backend that lives here in `worker/src/gepa/`; it runs on the
Temporal substrate described in [`../temporal/README.md`](../temporal/README.md)
(see [ADR-0006](../../../docs/adr/0006-temporal-for-durable-orchestration.md) for the why).
The read/create UX lives in the Next app under `src/app/optimizations/`.

## The idea, simply

GEPA improves an LLM system's *prompt* — not its weights. Two ideas carry it:

- **Reflective mutation.** Look at a prompt's actual outputs and the Rubric's
  per-criterion reasoning, then have a capable model (Sonnet) write a better prompt.
  Rich textual feedback beats a scalar reward, so it improves in very few runs.
- **Pareto selection.** Don't just keep the single best-on-average prompt. Keep a
  *diverse frontier* of prompts that each win on **some** inputs, so the search
  doesn't collapse into one mediocre local optimum.

## Vocabulary

The domain terms — **Optimization Run**, **Module**, **Candidate**, **Instance**,
**Rollout**, and **Reflection** — are defined in the project glossary,
[`CONTEXT.md`](../../../CONTEXT.md) (under *Optimization*). GEPA's paper uses the same
names; this README uses them as the glossary defines them.

Two implementation notes the glossary deliberately omits:

- A **Module** is injected into the agent's request template via a `{{prompt:<name>}}`
  placeholder (e.g. `system`, `style`). **Generation 0** of the Candidate tree is the
  seed (your starting prompts).
- **Reflection** runs on the provider's most-capable model (e.g. Sonnet for Anthropic),
  overridable per run; the Rubric's judge stays cheap (e.g. Haiku for Anthropic). A run is
  single-provider — judge and reflect use the same provider as the run's chosen reflect model
  (`defaultJudgeModelForProvider`, #204). A Rollout has two phases — a cheap `minibatch`
  (accept/reject) and the full-set `pareto` score.

## Architecture

The loop can run for minutes and must survive deploys, restarts, and scale-to-zero,
so it doesn't run on a request. It's a **Temporal workflow**; the side effects are
**Activities** on the worker.

```
Vercel (server action)         Temporal (durable workflow)          Worker (on Fly)
 startOptimizationRun()  ──▶    runOptimizationWorkflow      ──▶     Activities:
   - authz, freeze inputs         the GEPA loop, carrying only         seedRun, rolloutCandidate,
   - insert run (queued)          IDs (ADR-0006)                       proposeCandidate,
   - start the workflow                │                               completeRun, failRun
        │                              ▼
        ▼                        all reads/writes go through Activities
   Supabase Postgres  ◀──────────────────────────────────────────────────┘
   (system of record)
```

Three rules, baked in from day one (ADR-0006):

1. **Postgres is the system of record.** Temporal holds orchestration state only;
   every prompt, output, and score lives in Supabase.
2. **Pass IDs, not blobs.** The workflow carries `optRunId` / `candidateId`; Activities
   load the real data from Postgres. Keeps Temporal history small and sensitive data
   out of it.
3. **One connection seam** owns Temporal address/namespace/TLS, so Cloud-now →
   self-host-later is a config change, not a rewrite.

## Data model

Five dedicated tables (migrations under `supabase/migrations/*_optimization*.sql`),
kept separate from the user-facing `eval_runs` so optimizer internals never touch
rubric run-history:

| Table | Holds |
|---|---|
| `optimization_runs` | One row per run: org, connection, rubric, `budget_rollouts`, `max_iters`, `plateau_patience`, `reflect_model`, `status` (queued/running/completed/failed), `best_candidate_id`, `best_score`, `workflow_id`, `error_message`. A **partial unique index** enforces one active run per org. |
| `optimization_candidates` | Each Candidate's `prompts` (`{module: text}` JSON), `generation`, `iteration`, `target_module`, `parent_id` (primary lineage). `merged_from_id` (#84) is a nullable second-parent pointer, set only on a system-aware-merge hybrid — null for the seed and every ordinary mutation child. |
| `optimization_inputs` | The frozen instance set. |
| `optimization_rollouts` | One Candidate run against one instance, tagged `phase` = `minibatch` or `pareto`. |
| `rollout_results` | Per-criterion `{score, reasoning}` from the judge. |

A Candidate's **per-instance score vector** (what Pareto needs) is derived by
aggregating `rollout_results` across criteria; the **overall score** is the
weighted per-criterion average (`scoring.ts`, mirrored read-side in
`src/lib/optimization/score.ts`).

## The loop (`workflow.ts`)

**Setup.** `seedRun` creates Candidate 0 from the connection's seed Modules and
returns the Modules + instance count + termination knobs. The seed is then scored on
the **full frozen set** (a `pareto` rollout) — the baseline and the pool's first member.

**Each iteration** (round-robin over the Modules — iter 1 tunes `system`, iter 2 `style`, …):

1. **Pareto-sample a parent** from the frontier, weighted by how many instances it wins
   (`pareto.ts`; `Math.random()` is replay-safe inside Temporal).
2. **Roll the parent on a minibatch** (~5 instances). This is the accept/reject baseline
   *and* the feedback the reflection reads.
3. **`proposeCandidate`** — reflection rewrites the target Module → a child Candidate.
4. **Roll the child on the same minibatch.**
5. **Accept only if the child strictly beats the parent.** If accepted, score it on the
   **full Pareto set**, add it to the pool, and update the headline best if it's a new high.

**Termination** — whichever trips first: the **rollout budget** (a hard ceiling on agent
calls = spend), **max iterations**, or a **plateau** (no frontier gain for N iterations).
Then `completeRun` sets `best_candidate_id` / `best_score`.

> Reading the activity timeline: `proposeCandidate` sits mid-iteration, so the visual
> "propose + N rollouts" grouping is an artifact — a group of **3** = an accepted child
> (child minibatch + child pareto + the *next* iteration's parent minibatch), a group of
> **2** = a rejected child. The number after each `propose` tells you whether that child
> was accepted.

## The merge step (`merge.ts`, #84)

GEPA's optional **system-aware merge/crossover**: alongside mutation, every
`MERGE_EVERY_K_ITERS` (5) completed iterations the workflow also tries combining two Candidates
instead of just mutating one. **Reflective + multi-Module only** — with a single Module a merge
can never differ from either parent, so the check is skipped entirely (Simple Mode never imports
`merge.ts` either; it has no Pareto frontier, just `selection.ts`'s flat `topK` population).

The whole step is behind a **PostHog feature flag**, `system-aware-merge`
(`SYSTEM_AWARE_MERGE_FLAG`, `merge.ts`) — an operational kill switch, targetable per Team since
it's evaluated with the run's **org id** as distinctId. The workflow sandbox never reads env or
calls PostHog: `seedRun` resolves the flag **once per run** via `isKillSwitchFlagEnabled`
(`worker/src/telemetry.ts`) and carries the verdict into the workflow as
`SeedRunResult.mergeEnabled` (the same "value rides an Activity result" pattern as the eval
fan-out concurrency), so a run's behavior stays consistent even if the flag flips mid-run.
Default matrix: PostHog **not configured** (no `POSTHOG_KEY` — dev/test) → **enabled** (an
environment with no control plane keeps the shipped behavior); PostHog **configured** → the flag
decides, and an evaluation error or undefined result fails to **disabled**. The check never
throws — a telemetry failure can't fail `seedRun`.

1. **Pick a complementary pair** off the Pareto frontier — two Candidates that each win at
   least one instance the other loses (`selectComplementaryPair`). Deterministic: frontier
   members are considered in descending win-count order and the first complementary pair found
   wins; returns nothing when the frontier is degenerate (fewer than two winners, or one
   candidate's wins are a strict subset of the other's).
2. **Combine their prompts per Module** (`combineModulePrompts`) — round-robin the run's Modules
   between the pair, starting with whichever parent has the higher overall score (a
   `candidateId` tiebreak keeps an exact-tie start deterministic). This is deliberately simple,
   documented recombination, NOT reflection-guided crossover — no LLM call, so nothing touches
   metering/billing.
3. **Persist the hybrid** via the `mergeCandidates` Activity — idempotent on a per-run
   `mergeIteration` key (a *negative* number, so it never collides with a mutation child's
   positive `iteration`), mirroring how `proposeCandidate` keys its own idempotency. The row's
   `parent_id` is the stronger parent (primary lineage, unchanged read shape); `merged_from_id`
   is the other parent.
4. **Evaluate the hybrid on the full Pareto set** — reuses `rolloutCandidate`, so it counts
   toward `budget_rollouts` exactly like any other full evaluation. The merge is skipped
   entirely (no Activity call) when the remaining budget can't cover this eval.
5. **Keep it only if it strictly beats BOTH parents'** overall score (`beatsBothParents`). A
   kept hybrid joins the pool like any Candidate (sampled as a future parent, eligible for
   `best_candidate_id`); a rejected one is persisted (visible in Candidate history) but never
   pooled, so it's never sampled again.

A failure during the merge's own rollout is classified through the same
`classifyIterationFailure` (`circuit-breaker.ts`) as the main iteration: a terminal run-level
failure (managed-spend cap, missing key, invalid managed-agent config) still fails the whole
run; anything else is logged and the merge attempt is simply skipped, without touching the
breaker/plateau counters (those track the primary mutation iteration only). No Temporal
`patched()`/versioning gate — this is a direct change to the workflow loop, not a replay-sensitive
one (there are no in-flight Optimization Runs).

## Guardrails (`circuit-breaker.ts`)

- **One active run per org** — DB partial-unique index + a UI gate.
- **Bounded parallelism** (~5 concurrent rollouts) — protects the endpoint, respects rate limits.
- **Circuit breaker** — K *consecutive* endpoint failures aborts the run (a dead endpoint
  can't burn the whole budget); marks it `failed` with the real reason.
- **Budget ceiling** — only enters an iteration if its guaranteed cost still fits.
- **Stale reaper** — backstop for runs that wedge (`supabase/migrations/*_reap_stale_optimization_runs.sql`).
- **Terminal failures** — `isTerminalRunFailure` classifies three permanent, non-retryable
  conditions that the inner catch re-throws to `failRun`: managed-spend cap reached
  (`MANAGED_SPEND_BLOCKED`), invalid/missing managed-agent `target_model`
  (`MANAGED_AGENT_CONFIG`), and no provider key configured (`PROVIDER_KEY_MISSING`). Because
  none of these can recover through iteration retries, the workflow exits immediately instead
  of burning rollout budget on the seed. All three are non-retryable `ApplicationFailure`s so
  Temporal doesn't spin on replay while the row already reads `failed`.
- **BYO key failure attribution** — each activity's catch calls `logByoOptimizationKeyFailure`
  before rethrowing. When the failed call was made on a Team's own key (`source === "byo"`),
  it emits a `provider_key.byo_failed` warning log so operators can distinguish the customer's
  key being rejected from a platform outage. Managed-key failures do not emit this event.
  The helper never logs key material — only provider, `org_id`, `opt_run_id`, and HTTP status.
- **Run lifecycle logs & correlation** — `seedRun` emits `optimization_run.started` and
  `completeRun`/`failRun` emit `optimization_run.completed`/`.failed` (with score lift and a
  `created_at`-derived `duration_ms`) to PostHog Logs, the optimization parallel to the worker's
  eval-run terminal logs. Every Activity's logs auto-correlate by `opt_run_id`/`org_id` via the
  Temporal log-context interceptor (`worker/src/temporal/activity-log-context.ts`) — no call site
  threads the ids. A user-initiated cancel logs `optimization_run.cancelled` from the app
  (`src/app/actions/optimizations.ts`) instead, since the workflow is terminated before the worker
  reaches `completeRun`/`failRun`.

## The UX surface (`src/app/optimizations/`)

- **Read surface** — master-detail list + addressable detail (`?run=<id>` is the source of
  truth, so email deep-links open the right run).
- **Completed run** — a score-lift headline (`seed → best`), a per-Module **prompt diff**
  (seed vs optimized), and copy buttons.
- **In-progress / queued** — derived progress (rollouts spent vs budget, Candidates
  discovered) counted from child rows, on a ~4s poll that stops at terminal.
- **Failed** — the workflow's root-cause `error_message` verbatim, with an honest
  "No optimized prompt was produced."
- **Terminal emails** — the run starter gets a completed/failed email via the shared
  transport in `worker/src/emailer.ts` (Resend in production, Mailpit locally) — fired
  from `worker/src/optimization-emailer.ts` with the lift, rollouts spent, and a deep link.
- **Start wizard** (`optimization-wizard.tsx`) — Basics (Rubric) → System (existing agent,
  create one inline with a **Modules editor** + live `{{prompt:*}}` cross-validation, or
  paste a prompt as a Managed Agent) → Instances (manual / CSV / JSON, only `user_input`
  required) → Tuning (branches on Mode: Simple shows budget + generation-model picker +
  backstops under Advanced; Reflective shows budget + maxIters / plateauPatience /
  reflectModel under Advanced) → Review (names the chosen Mode).
  The **Optimization Mode** selector (Simple / Reflective) appears on the System step only
  for paste-a-prompt Managed Agents, defaulting to Simple; external and multi-module agents
  always run Reflective.
- **Cancel + gating** — a confirm-guarded Cancel (terminates the workflow + marks the run
  `failed` "Cancelled by &lt;user&gt;", freeing the slot immediately) behind a destructive
  dialog that Escape can't dismiss; "New run" is gated while a run is active and the list
  refreshes live.

## Where the code lives

| Path | Role |
|---|---|
| `worker/src/gepa/workflow.ts` | The durable GEPA loop (deterministic; no DB/Date/random) — a thin await-loop driving `optimization-step.ts`. |
| `worker/src/gepa/optimization-step.ts` | The pure candidate propose→rollout(s) step machine shared by GEPA and Simple Mode (#385): `driveOptimizationStep` runs it to completion, parameterized per Mode by an `OptimizationStepPolicy`. |
| `worker/src/gepa/pause-machine.ts` | The pure pause/probe episode state machine (#380) the GEPA workflow drives when the circuit breaker trips. |
| `worker/src/gepa/activities.ts` | `seedRun`, `rolloutCandidate`, `proposeCandidate`, `mergeCandidates` (#84), `completeRun`, `failRun` — the DB/agent/reflection side effects. |
| `worker/src/gepa/pareto.ts` | Frontier maths: per-instance maxima, frontier check, win-weighted parent sampling, accept gate. |
| `worker/src/gepa/merge.ts` | System-aware merge/crossover maths (#84): complementary-pair selection, per-Module prompt combination, the beat-both-parents accept gate. Reflective-only — Simple Mode never imports it. |
| `worker/src/gepa/scoring.ts` | Overall score from rollout results (weighted per-criterion). |
| `worker/src/gepa/circuit-breaker.ts` | Consecutive-endpoint-failure breaker + plateau advance + the outer loop's continuation guard (`shouldContinueLoop`) + per-iteration terminal-failure classification (`isTerminalRunFailure`, `classifyIterationFailure`) — shared by both Modes. |
| `worker/src/gepa/phase.ts` | The `minibatch` / `pareto` / `full` phase constants. |
| `worker/src/simple/workflow.ts` | The durable Simple (Monte Carlo) loop (#316, ADR-0015) — a thin await-loop driving the same `optimization-step.ts` machine, parameterized with no parent rollout / no accept gate / no follow-up eval. |
| `worker/src/simple/selection.ts` | Simple Mode's elite selection: top-k by score, uniform elite sampling — the Monte Carlo analog of `pareto.ts`. |
| `src/app/actions/optimizations.ts` | `startOptimizationRun`, `cancelOptimizationRun`, and the read actions (`listOptimizationRuns`, `getOptimizationRun`). |
| `src/lib/validation/schemas.ts` | `CreateOptimizationRunSchema`, `NewOptimizationConnectionSchema` (declared↔referenced cross-validation). |
| `src/lib/optimization/` | Read-side `score.ts`, the `models.ts` registry, `parse-instances.ts`, `prompt-refs.ts`. |
| `src/app/optimizations/` | The read surface + start wizard. |

## Running it locally

Prereqs (all up): local Supabase, the Temporal dev server, the worker,
the mock agent (`node scripts/mock-agent.mjs`), and the e2e
seed applied (`SEED_ENV=development npm run seed:e2e`).

Trigger a real run without the UI — seeds a deliberately weak-prompt demo agent so
reflection has headroom, then polls Postgres until the run settles and prints a summary:

```bash
cd worker
node --env-file=.env.local --import tsx/esm src/scripts/start-optimization.ts
```

Watch it in the Temporal Web UI at http://localhost:8233, or open `/optimizations` in the app.
