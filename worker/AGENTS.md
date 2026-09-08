# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## The provider-call ritual is one wrapper: `providers/provider-call.ts` (#384, ADR-0020)

Every LLM call a run makes — the eval judge, a Managed Agent's target, GEPA's rollout judge,
reflection propose, and Simple Mode generation (six call sites total) — resolves a provider key,
fails closed when there is none, builds the provider client, and classifies whatever the call
throws. That ritual lives ONCE in `src/providers/provider-call.ts` as `providerCall` (plus
`resolveProviderCall`/`runProviderCall`, split out for the one call site — `invokeAgentRow` — that
resolves per RUN and caches across many per-ROW Activities). A new call site should never
hand-roll this sequence again.

`providerCall({ scope, resolveKey, execute, providerOpts? })`: resolve the key via `resolveKey()`
(either the fixed-model strategy, `resolveKeyForModel` — 5 of the 6 sites — or the eval judge's
own provider-discovery, `resolveEvalJudge`) → fail closed (`scope.terminals.missingKey`) on no
key → call `execute({ provider, providerName, source })` → classify whatever it throws (a key
rejection is logged as `provider_key.byo_failed` with the key source; a model-not-found converts
to `scope.terminals.modelUnavailable`; anything else rethrows unchanged, so it's retried, never
silently absorbed). Nothing is metered.

One thing `provider-call.ts` does NOT unify, because the two run types genuinely differ: **the
`ApplicationFailure.type` marker.** Eval folds every terminal reason into one `"EvalRunTerminal"`
marker (`evalrun/activities.ts`'s local `terminal()`); GEPA's circuit breaker
(`gepa/circuit-breaker.ts`) branches the workflow on distinct markers per failure class
(`PROVIDER_KEY_MISSING_TYPE`, `MODEL_UNAVAILABLE_TYPE`). Each file's `ProviderCallScope.terminals`
carries its own pair — never share one `terminals` object across both run types.

A run resolves ONE provider key per role (judge, and a Managed Agent's target) via
`resolveProviderKey`/`resolveEvalJudge` (`src/providers/resolve-key.ts`); the result's `source` is
`"byo" | "env" | "none"` — a usable key saved under Settings → Provider keys (Vault) wins, else
the operator's env var named in `PROVIDER_KEY_ENV` (`registry.ts`), else none. This is the same
precedence the app applies (`src/lib/llm/key-gate.ts`), so a `provider_keys` row with an
empty/whitespace secret is never a key on one side and not the other. Two invariants ride on it:

- **Resolution happens exactly once.** When a provider rejects a key mid-run (401/403/429), the
  error propagates to the judge/agent Activity's catch and the run is marked failed — there is
  no re-resolution to any other key. Do not add a "retry on another key" path.

- **`provider_key.byo_failed` log.** The classify step attributes a failed provider call to the
  key in use (`key_source: byo | env`) via `classifyProviderError`
  (`src/providers/provider-error.ts`, which normalizes the fetch clients' `ProviderHttpError` and
  the Anthropic SDK's `Anthropic.APIError` to `{provider, status}`). A non-key failure (a retired
  MODEL, a provider outage) is never attributed to the key. NEVER log key material — only
  provider, `org_id`, run id, source, and the HTTP status/error.

## Ambient run correlation for worker logs (#38)

The worker logger (`src/log.ts`) auto-stamps every PostHog record with the ambient run's
identity from an AsyncLocalStorage scope (`src/log-context.ts`), so deep call sites
(provider clients, the evaluator, GEPA activities) correlate to their run with zero
signature threading — the worker-side mirror of the app logger's per-request `request_id`
stamping (`src/lib/logging/server.ts`). An explicit attribute on the log call always wins
over the ambient value.

- **Eval runs** and **optimization runs** both run as Temporal Activities, so the inbound
  Activity interceptor (`src/temporal/activity-log-context.ts`, registered on the Temporal Worker
  via `interceptors.activity` in `src/temporal/worker.ts`) opens the scope per Activity from the
  Activity args: `opt_run_id` for optimization Activities (`optRunId`, or the bare id for
  `seedRun`), `run_id` for eval Activities (`evalRunId`, or the bare id for `prepareEvalRun`).
  `org_id` is patched in via `setLogContext` once the run/rubric loads. `run_id` and `opt_run_id`
  are distinct id namespaces, each correlating to its own table. The pgmq dispatcher in
  `worker.ts` also opens a short `run_id` scope around the dispatch of a scheduled eval run.
- **`duration_ms` on terminal events** — terminal Activities have no run-wide scope on
  either path (each Activity opens its own), so both derive it from the row's `created_at`:
  eval terminal events in `evalrun/activities.ts`, optimization ones via `durationMsSince`
  in `gepa/activities.ts`. The dispatcher's `eval_run.workflow_started` still reads
  `runElapsedMs()` from its own short dispatch scope.

Run lifecycle events are queryable: eval `eval_run.dequeued` / `.workflow_started`
(`worker.ts` dispatcher) plus the terminal `eval_run.completed` / `.failed` from the
workflow's Activities (`src/evalrun/activities.ts`, emitted only by the attempt that flips
the status so retries can't double-count), optimization `optimization_run.started` (`seedRun`) /
`.completed` / `.failed` (`completeRun`/`failRun` in `gepa/activities.ts`). A user-initiated cancel/retry
instead logs `optimization_run.cancelled/retried` from the app server action
(`src/app/actions/optimizations.ts`), since an abrupt cancel terminates the workflow before
the worker reaches its terminal path.

## Eval-run execution: Temporal-only, pgmq is scheduling-only (#123, ADR-0006)

Eval runs execute **exclusively** as the durable Temporal workflow `runEvalWorkflow`
(`src/evalrun/`). There is no pgmq execution path and no feature flag — Temporal must be
reachable in every environment that runs the worker (`startTemporalWorker` is unconditional, and
`worker.ts` refuses to start if it can't register).

- **Interactive runs:** `createEvalRun` (`src/app/actions/eval-runs.ts`) checks a provider key
  exists, stamps `eval_runs.workflow_id` (`eval-<runId>`), and starts the workflow directly via
  the Temporal client. No pgmq enqueue.
- **Scheduled runs:** `pg_cron tick_schedules()` → `enqueue_eval_run` → pgmq is the **scheduling
  broker only**. The worker's poll loop (`worker.ts`) is a thin **dispatcher** (`dispatchEvalRun`):
  it stamps `workflow_id` and starts `runEvalWorkflow`, then acks — it runs **no eval logic**. A
  stable `workflowId` makes a redelivered message a harmless already-started no-op
  (`WorkflowExecutionAlreadyStartedError` → ack). A real start failure does NOT ack, so pgmq
  redelivers and dispatch retries once Temporal recovers. Keep the pgmq RPCs
  (`dequeue/ack/enqueue_eval_run`) and the wake endpoint — they still drive scheduling.
- **Workflow shape** (`evalrun/workflow.ts`): `prepareEvalRun` (claim queued→running, resolve
  rows) → for an agent Connection, fan out one `invokeAgentRow` Activity per row (bounded
  concurrency) → `judgeEvalRun` → `completeEvalRun`. A quiet dataset window is terminal in
  `prepareEvalRun` (marks skipped) and returns a SKIPPED outcome so the workflow just returns.
- **Keys are FIRST-CLASS in the Activities** (`evalrun/activities.ts`):
  - `judgeEvalRun` resolves the judge via `resolveEvalJudge` (a saved key, else the operator's
    env key) through `providerCall`, failing closed (nonRetryable) on a keyless Workspace.
  - `invokeAgentRow` resolves a Managed Agent's target key independently (Anthropic-only) and
    runs it on the managed LLM (#292).
  - `evaluateRun` (`src/evaluator.ts`) fans every `(row × criterion)` judge call out via
    `mapWithConcurrency` at `JUDGE_CONCURRENCY` — the ONE fan-out. Do NOT add a separate coarse
    judge fan-out; the judge Activity calls `evaluateRun` per row for durable checkpointing and
    reuses this concurrency.
  - Every terminal outcome — complete, fail, skip — goes through `settleTerminalRun`
    (`src/settle-terminal-run.ts`): a guarded status transition plus the log/email that fires
    only when THIS call flipped the status. There is nothing financial to settle (ADR-0020).
- The agent fan-out cap is `EVAL_AGENT_FANOUT_CONCURRENCY` (default 5), resolved in `prepareEvalRun`
  (Activity/Node) and **returned** to the workflow — the workflow must never read env from the
  deterministic sandbox, so the value rides the Activity result. The judge fan-out cap is
  `EVAL_JUDGE_CONCURRENCY` (default 5), read directly in `evaluateRun` (`src/evaluator.ts`) — that
  runs only inside the `judgeEvalRun` Activity (Node), never the sandbox, so a direct `process.env`
  read at module load is safe. Both default to 5.
- Every eval run is workflow-driven by the time it is `running`, so `reap_stale_eval_runs` is inert
  (kept as a safety net); Temporal owns retries/resumption while the workflow is alive, and the
  worker's liveness-grounded sweep (`reapOrphanedWorkflowRuns` in `worker.ts`) recovers
  workflow-stamped runs whose workflow died without a terminal status (it `describe`s the
  workflow before reaping). `failEvalRun`'s guarded `running→failed` write (status + reason)
  stays the source of truth the UI reads; the failure also reaches PostHog error tracking via
  `captureException` (guarded by the flip, so retries can't double-report), plus a best-effort
  notification email.

## Email theming

Report emails (eval-run in `src/emailer.ts`, optimization in `src/optimization-emailer.ts`)
use the Baseline Design System chrome via `src/email-layout.ts` (`wrapEmail` / `ctaButton` /
`EMAIL`). That file is a deliberate copy of the canonical app-tier source
`src/lib/email/templates/layout.ts` — the worker is independently Dockerized (the Dockerfile
copies only `worker/src`), so it cannot import from the app's `src/`. Keep the copy in sync
when the design system chrome changes. `wrapEmail`'s `previewText` is NOT escaped by the
wrapper, so HTML-escape any caller-supplied values before interpolating them via `escapeHtml`
from `src/escape.ts` — itself a worker-local copy of `src/lib/email/templates/escape.ts`,
shared by both emailers (same mirror convention as `email-layout.ts`).

## Dataset-adapter subtree uses extensionless imports (#39)

Relative imports inside the dataset-adapter subtree — `src/adapters/{index,custom,posthog}.ts`
and their `safe-fetch.ts` / `template.ts` / `posthog-hosts.ts` / `ip-ranges.ts` deps — are
deliberately **extensionless**, not the worker's usual NodeNext `.js` specifiers. The Next app
reuses this exact seam for its "Test query" dataset preview and bundles it with Turbopack, which
does NOT resolve a `.js` specifier to its `.ts` source. Extensionless resolves identically under
the worker's tsx runtime, the `tsc` build, vitest, and Turbopack, so the seam stays one shared
definition with no behavior change. If you add a worker file to this app-reachable subtree, keep
its relative imports extensionless (type-only imports are stripped before bundling and may stay
`.js`). See the root `AGENTS.md` "Dataset Connections" section for the full rationale.

## `providers/registry.ts` is the shared provider/model registry, app-reachable (#379)

`src/providers/registry.ts` is the single source for "Baseline supports provider X at price Y with
default judge/reflect model Z" — provider ids/labels/runtime-readiness, BYO key-format patterns,
per-provider model lists, `MODEL_PRICES`, and the judge/reflect defaults. It replaced three
hand-mirrored files (`provider-list.ts`, `models.ts`, `model-prices.ts`) plus their app-side copies
and the parity tests that pinned them together — every worker module that used to import one of
those three now imports `registry.js` instead. Unlike the dataset-adapter subtree, this file has
**zero relative imports by design**, so it sidesteps the extensionless-import sharp edge entirely
rather than needing to follow it — keep it that way; if it ever needs to import another worker
file, that import must be extensionless (same rule as the dataset-adapter subtree, since the app
imports this file too, via thin shims at `src/lib/llm/providers.ts` / `model-prices.ts` / `keys.ts`
and `src/lib/optimization/models.ts`). `defaultJudgeModelForProvider`/`defaultReflectModelForProvider`
read `process.env.ANTHROPIC_MODEL` and are Node-only — the app never imports them into
client-reachable code; see root `AGENTS.md`'s "LLM providers" section.

## Optimization Run termination reasons (#469)

A run that completes without ever entering iteration 1 used to look identical to a genuine
optimization pass: status `completed`, best candidate = the seed, no error. `gepa/termination-reason.ts`
is the single source of the reason CODE set (`TERMINATION_REASONS`, zero relative imports — same
convention as `providers/registry.ts`) and the pure decision function `deriveTerminationReason`
(modules/instance counts + the loop's own 0-based completed-iteration count → a code or `null`).
Both `gepa/workflow.ts` and `simple/workflow.ts` call it once, right before their `completeRun`
call, and thread the result through as `CompleteRunInput.terminationReason` — the terminal
Activity (`gepa/activities.ts`) is the one write path for both Modes, so there's no second
persistence site to keep in sync. Persisted as `optimization_runs.termination_reason` (nullable
text, CHECK-constrained to the code list, migration `20260709010000_optimization_termination_reason.sql`);
the app re-exports the code set via `src/lib/optimization/termination-reason.ts` (same
thin-shim convention as `src/lib/llm/providers.ts`) so the run detail panel's code → copy mapping
can't drift from what the workflow actually writes. Shipped as a direct workflow edit with no
`patched()`/versioning gate, same rationale as #84: it only changes the INPUT payload of the
existing `completeRun` Activity call (a value computed from state the workflow already has, no
new Activity call or branch in the scheduled-command sequence), so an in-flight run's replay
history — which pins Activity call order/type, not input equality — is unaffected.

## GEPA system-aware merge/crossover (#84)

Alongside mutation, the GEPA workflow (`gepa/workflow.ts`) also tries a periodic **merge**:
every K completed iterations — the operator-set **`MERGE_EVERY_K_ITERS` env var**, default
`DEFAULT_MERGE_EVERY_K_ITERS` = 5 (`gepa/merge.ts`); positive integers only, anything
non-numeric/zero/negative falls back to the default — combine two complementary
Pareto-frontier Candidates' per-Module prompts into one hybrid and keep it only if it beats BOTH
parents' overall score. **Reflective + multi-Module only** — a single-Module run can't produce a
hybrid that differs from its parents, so the whole feature is skipped, and Simple Mode
(`simple/workflow.ts`) never imports `merge.ts` at all (it has no Pareto frontier — see
`selection.ts`'s flat `topK`).

The step is gated by the **PostHog feature flag `system-aware-merge`**
(`SYSTEM_AWARE_MERGE_FLAG`, `gepa/merge.ts`) — an operational kill switch that can turn the merge
off (or roll it out per Team) without a deploy. The workflow sandbox must never read env or call
PostHog, so `seedRun` resolves the flag AND the cadence knob ONCE per run — the flag via
`isKillSwitchFlagEnabled` in `src/telemetry.ts`, evaluated with the run's **org id** as
distinctId for per-Team targeting; the cadence via `resolveMergeEveryKIters` in `gepa/merge.ts`
(pure parse, env read stays in the Activity) — and returns them as `SeedRunResult.mergeEnabled` /
`.mergeEveryKIters`, the same "config rides an Activity result" pattern as the eval fan-out
concurrency. One resolution per run keeps a run's behavior consistent end to end, and pins the
negative merge-iteration idempotency keys to one divisor so they can't collide within a run when
the operator changes K between runs. Default matrix (deliberately asymmetric): PostHog **unconfigured** (no `POSTHOG_KEY`,
dev/test) → **enabled**, the shipped behavior; PostHog **configured** → the flag decides, with an
evaluation error or undefined result failing to **disabled** (don't run the gated path when the
control plane can't be read). The helper never throws, so a telemetry failure can't fail
`seedRun`.

The math is pure and directly unit-tested (`merge.ts`/`merge.test.ts`), same shape as
`pareto.ts`: `selectComplementaryPair` (deterministic — no random draw needed, unlike
`sampleParent`) and `combineModulePrompts` (round-robin the Modules, starting with the
higher-scoring parent; a `candidateId` tiebreak on an exact score tie). The recombination is
deliberately simple deterministic prompt-mixing, NOT reflection-guided crossover — it makes no
LLM call, so it never touches `provider-call.ts`. Persisting the hybrid is a new
idempotent Activity, `mergeCandidates` (`gepa/activities.ts`), keyed like `proposeCandidate` but
on a *negative* `mergeIteration` (so it can never collide with a mutation child's positive
1-based `iteration` — both share the `optimization_candidates(opt_run_id, iteration)` unique
index). The hybrid's full-set evaluation reuses `rolloutCandidate`, so it draws from
`budget_rollouts` exactly like any other full evaluation; the workflow skips the whole merge
attempt (no Activity call) when the remaining budget can't cover it. A hybrid that's kept joins
the pool like any Candidate; a rejected one is persisted (`parent_id` = the stronger parent,
`merged_from_id` = the other — a nullable column added by migration, null for every non-merge
Candidate) but never pooled, so it's never sampled as a future parent. A failure during the
merge's own rollout is classified through the same `classifyIterationFailure` as the main
iteration body: a terminal run-level failure still fails the whole run; anything else is logged
and the merge attempt is simply skipped, without touching the breaker/plateau counters. No
Temporal `patched()`/versioning gate guards this change — it went in as a direct edit to the live
GEPA loop rather than a replay-sensitive one, since there were no in-flight Optimization Runs at
the time.

## Optimization runs carry an explicit reflect provider (#485)

`optimization_runs.reflect_provider` (nullable, CHECK-constrained to the provider ids) is stamped
at creation by `createOptimizationRun` after server-side model/provider validation, so a BYO Team's
live-listed (non-registry) reflect/generation model routes to the right provider instead of
`providerForModel()`'s Anthropic fallback. `reflectProviderForRun` (`src/gepa/run-provider.ts`) is
the one decision: stored provider wins; null (pre-#485 rows) falls back to the registry map —
old rows and registry models resolve byte-for-byte as before. Every reflect/judge call site in
`gepa/activities.ts` threads it through `resolveKeyForModel`'s optional `provider` param, and
`resolveProviderCall` constructs the runtime client from the RESOLVED provider (`createProvider`),
never the model's registry mapping. The provider clients (`AnthropicProvider`, `FetchProvider`)
accept a non-registry reflect model only when constructed with `allowUnlistedReflectModel` (set iff
the run has a stored provider); a registry model of ANOTHER provider still falls back to the
default with a warn — that's a misroute, not a new model. If the saved key vanishes before
execution and no env key covers the provider, resolution fails closed with the missing-key copy.

**#488 hardening — `reflect_provider` non-null means VALIDATED, and a vanished key never blames the
customer.** `createOptimizationRun` stamps `reflect_provider` ONLY when the pair was validated (an
explicit provider that passed `isModelAvailableForProvider`, or an omitted-provider REGISTRY model
where the registry is the validation); an omitted-provider non-registry id is stamped `null`, so the
worker's `allowUnlistedReflectModel = reflect_provider != null` truly means "validated against a
live list", never an unvalidated Anthropic guess. Two runtime consequences ride on that: (1)
`provider-call.ts`'s `provider_key.byo_failed` attribution fires ONLY for genuine key-rejection
statuses (401/403/429) — a 400/404 model-not-found from a live-listed model the provider retired
between run creation and execution is OUR catalog drift, not the customer's key, so it is not
attributed to the key. Instead, `provider-call.ts` classifies that 400/404 as its own nonRetryable
terminal (`MODEL_UNAVAILABLE_TYPE`, `gepa/circuit-breaker.ts`, folded into `EvalRunTerminal` on the
eval side) with a comprehensible "the selected model is no longer available from {provider}" message
— so a retired reflect/generation (or target) model fails the run fast with a clear reason instead
of the Activity retrying the doomed id opaquely (a retry-storm), and GEPA's `isTerminalRunFailure`
re-throws it past the loop's inner catch to `failRun`; (2) the app's submit-time re-validation
(`isModelAvailableForProvider`, `src/lib/llm/live-models.ts`) re-reads the live list FRESH (cache
bypassed) so a deleted key refuses cleanly, refuses a live id the registry maps to a DIFFERENT
provider (the worker would reject that pair), and does NOT refuse on a transient couldn't-reach
provider blip.
