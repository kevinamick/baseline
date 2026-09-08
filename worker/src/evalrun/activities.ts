// Eval Run Activities (#123, ADR-0006). All Postgres access for a Temporal-executed Eval
// Run lives here: the Workflow carries only the run id (and row indexes), and these
// Activities read the real rows/rubric and write outputs/results back. They reuse the same
// agent-invocation (invokeAgent/invokeManagedAgent), dataset-adapter, evaluation (evaluateRun),
// key resolution and email logic the pgmq path used, so scores and notifications match the
// old executor for the same inputs. Registered into the Temporal worker by re-export from
// temporal/activities.ts. This is plain Node — no sandbox constraints.
//
// Idempotency contract (Activities are at-least-once): the queued→running claim accepts an
// already-running run, dataset rows are only fetched when none exist yet, agent invocations
// skip rows whose output is already persisted, judging checkpoints per row and skips rows
// whose results are already persisted, results are upserts on the (eval_run_id, row_index,
// criterion_name) unique constraint, and the terminal transitions (completed/failed) are
// guarded — they only fire from a non-terminal status, so a retried Activity can never
// overwrite skipped/completed with failed or send a duplicate terminal email. Point
// settlement + managed-reservation release are idempotent in Postgres, so they are safe on
// every terminal path even under Activity retries.
//
// Billing is FIRST-CLASS on this path (nothing regresses vs the old pgmq executor):
//   - The judge Activity resolves the judge provider via resolveEvalJudge (a saved key, else
//     the operator's env key), failing closed when there is none (ADR-0020).
//   - A Managed Agent's target invocation resolves its key the same way (#292).

import { createClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";
import { resolveEvalJudge, MISSING_PROVIDER_KEY_MESSAGE } from "../providers/resolve-key.js";
import { isAnthropicModel } from "../providers/registry.js";
import {
  providerCall,
  resolveKeyForModel,
  resolveProviderCall,
  runProviderCall,
  type ProviderCallScope,
  type ProviderCallContext,
} from "../providers/provider-call.js";
import {
  computeOverallScore,
  evaluateRun,
  type RowCriterionResult,
  type Rubric,
} from "../evaluator.js";
import { invokeAgent, invokeManagedAgent } from "../agent.js";
import { getDatasetAdapter, type DatasetConnection } from "../adapters/index.js";
import { sendCompletionEmail, sendFailureEmail } from "../emailer.js";
import { trackRunCompleted } from "../telemetry.js";
import { log } from "../log.js";
import { setLogContext } from "../log-context.js";
import { captureException } from "../telemetry.js";
import { settleTerminalRun } from "../settle-terminal-run.js";
import {
  AGENT_KIND,
  DATASET_KIND,
  MANUAL_KIND,
  READY,
  SKIPPED,
  type EvalRunInputKind,
} from "./kind.js";

// Guarded-transition status lists (#378): a normal completion only ever leaves 'running'; a
// failure/skip/billing-block can strike before the workflow ever claims the run (a terminal
// misconfiguration surfaced by prepareEvalRun) or while it's running.
const FROM_RUNNING = ["running"] as const;
const FROM_QUEUED_OR_RUNNING = ["queued", "running"] as const;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Eval runs fold every terminal reason (missing key, a retired model) into the ONE
// "EvalRunTerminal" ApplicationFailure type (see terminal() below) — unlike GEPA's circuit
// breaker, which branches on distinct markers per failure class (gepa/activities.ts,
// gepa/circuit-breaker.ts). provider-call.ts's ProviderCallTerminals carries whichever set a
// caller's workflow reads; this is the eval-run set.
const PROVIDER_TERMINALS = {
  missingKey: "EvalRunTerminal",
  modelUnavailable: "EvalRunTerminal",
};

function providerScope(evalRunId: string, orgId: string): ProviderCallScope {
  return { supabase, orgId, run: { evalRunId }, terminals: PROVIDER_TERMINALS };
}

// Base URL for the run's deep link in terminal-state emails (mirrors the old worker's APP_URL).
const APP_URL = process.env.APP_URL ?? "https://baseline.app";

// In-run cap on live agent-invocation fan-out (one Activity per row), env-configurable with a
// default of 5 — mirrors the JUDGE_CONCURRENCY / ROLLOUT_CONCURRENCY knobs. Resolved here in
// Activity/Node context (once at module load, like the sibling knobs) and returned from
// prepareEvalRun so the workflow can bound its fan-out WITHOUT reading env from the deterministic
// sandbox. A non-positive or unparseable value falls back to 5.
const AGENT_FANOUT_CONCURRENCY = (() => {
  const parsed = parseInt(process.env.EVAL_AGENT_FANOUT_CONCURRENCY ?? "5", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

// PostgREST caps every select at `max_rows` (1000 in supabase/config.toml) and SILENTLY
// truncates past it. An eval run can be 10,000 rows (schedule maxRows) × 20 criteria, so any
// read that scales with run size must page — a truncated checkpoint read would re-judge (and
// re-judge) everything past the cap on every retried Activity.
const SELECT_PAGE_SIZE = 1000;

async function selectAllPages<T>(
  what: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += SELECT_PAGE_SIZE) {
    const { data, error } = await build(from, from + SELECT_PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load ${what}: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    if (page.length < SELECT_PAGE_SIZE) return all;
  }
}

// ---- Activities ----

export type PrepareEvalRunResult =
  | { outcome: typeof SKIPPED }
  | {
      outcome: typeof READY;
      kind: EvalRunInputKind;
      rowIndexes: number[];
      // The agent fan-out cap (EVAL_AGENT_FANOUT_CONCURRENCY, default 5), resolved in this
      // Activity so the workflow stays deterministic.
      agentFanoutConcurrency: number;
    };

// Claim the run (queued → running) and resolve its input rows, mirroring the pgmq path:
//   - manual:  rows were inserted complete at create time — nothing to resolve.
//   - dataset: fetch complete rows from the source over the Schedule's window and persist
//              them; an empty window marks the run 'skipped' (terminal, no email).
//   - agent:   the Schedule copied fixed inputs with empty agent_output — the workflow
//              fans out invokeAgentRow over the returned row indexes next.
// Terminal misconfigurations (run/rubric missing, no input rows for a manual/agent run)
// throw nonRetryable ApplicationFailures: retrying cannot fix them, and the workflow's
// catch records the clear reason on the run.
export async function prepareEvalRun(evalRunId: string): Promise<PrepareEvalRunResult> {
  const run = await loadEvalRun(evalRunId);

  // Surface a missing rubric before claiming the run, like the pgmq path does. The org load
  // also patches the tenant onto the ambient log scope (worker/AGENTS.md: `org_id` is patched
  // in via setLogContext once the run/rubric loads).
  const orgId = await loadOrgId(run.rubric_id);
  setLogContext({ org_id: orgId });

  // The judge key gates the whole run (old-executor parity): resolve it BEFORE the claim and
  // the agent fan-out, so a run that cannot judge (the key was removed after scheduling)
  // fails with the clear reason and ZERO agent calls —
  // instead of invoking the customer's live endpoint for every row and then failing at the
  // judge. judgeEvalRun re-resolves at judge time (keys can change mid-run); this is the
  // fail-fast, not the authority.
  const { resolved: judgeKey } = await resolveEvalJudge(supabase, orgId);
  if (judgeKey.source === "none") throw terminal(MISSING_PROVIDER_KEY_MESSAGE);

  // Claim queued → running. Accept 'running' too so a retried Activity (first attempt
  // claimed, then crashed before returning) proceeds instead of deadlocking; a run already
  // in a terminal state must not be re-executed.
  const { data: claimed, error: claimError } = await supabase
    .from("eval_runs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", evalRunId)
    .in("status", ["queued", "running"])
    .select("id")
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim eval run: ${claimError.message}`);
  if (!claimed) throw terminal("Eval run is already in a terminal state");

  let kind: EvalRunInputKind = MANUAL_KIND;
  if (run.schedule_id) {
    const { schedule, connection } = await loadScheduleConnection(run.schedule_id);
    if (connection.kind === DATASET_KIND) {
      kind = DATASET_KIND;
      const resolved = await resolveDatasetRows(evalRunId, connection, schedule);
      if (!resolved) {
        await markSkipped(evalRunId, "No rows returned for the configured window");
        return { outcome: SKIPPED };
      }
    } else {
      kind = AGENT_KIND;
    }
  }

  // Paged: a schedule window can be up to 10,000 rows — PostgREST would silently cap an
  // unpaged select at 1,000 and the workflow would only ever invoke/judge the first 1,000.
  const rows = await selectAllPages<{ row_index: number }>("rows", (from, to) =>
    supabase
      .from("eval_run_rows")
      .select("row_index")
      .eq("eval_run_id", evalRunId)
      .order("row_index", { ascending: true })
      .range(from, to)
  );

  // An agent (or manual) run with no rows means its fixed input set is missing — a real
  // error that should fail and alert. (A quiet dataset window already returned above.)
  if (!rows.length) throw terminal("No input rows found");

  return {
    outcome: READY,
    kind,
    rowIndexes: rows.map((r) => r.row_index as number),
    agentFanoutConcurrency: AGENT_FANOUT_CONCURRENCY,
  };
}

export interface InvokeAgentRowInput {
  evalRunId: string;
  rowIndex: number;
}

interface AgentRunContext {
  connection: DatasetConnection;
  authValue: string | null;
  orgId: string;
  // Managed Agent (#292): the target invocation runs on the Workspace's key through the
  // resolved host-pinned provider. An external agent leaves this null and POSTs its endpoint
  // with authValue instead.
  managed: boolean;
  target: ProviderCallContext | null;
}

// Per-run context for the agent fan-out. The run → schedule → connection resolution, the Vault
// credential decrypt, and (for a Managed Agent) the target-key resolution are
// identical for every row of one run, so they resolve once per run per worker process instead
// of repeating per row. Keyed by the run id; the promise is shared by concurrent rows, evicted
// on load failure (so a retried row re-resolves rather than replaying a cached rejection) and by
// the run's terminal Activities. Best-effort: a worker restart re-resolves on the next row.
const agentContextCache = new Map<string, Promise<AgentRunContext>>();

// Temporal distributes a workflow's Activities across worker processes, so the terminal Activity
// (completeEvalRun/failEvalRun, which evicts) may run on a different process than the one that
// cached the context here — leaving that entry to live for the process lifetime. Bound the map so
// a multi-worker deployment can't grow it unboundedly; eviction is safe because getAgentRunContext
// re-resolves on a miss (the cache is a pure best-effort optimization).
const AGENT_CONTEXT_CACHE_MAX = 256;

function getAgentRunContext(evalRunId: string): Promise<AgentRunContext> {
  let context = agentContextCache.get(evalRunId);
  if (!context) {
    context = loadAgentRunContext(evalRunId);
    context.catch(() => agentContextCache.delete(evalRunId));
    agentContextCache.set(evalRunId, context);
    if (agentContextCache.size > AGENT_CONTEXT_CACHE_MAX) {
      const oldest = agentContextCache.keys().next().value;
      if (oldest !== undefined) agentContextCache.delete(oldest);
    }
  }
  return context;
}

async function loadAgentRunContext(evalRunId: string): Promise<AgentRunContext> {
  const run = await loadEvalRun(evalRunId);
  if (!run.schedule_id) throw terminal("Eval run has no schedule — nothing to invoke");
  const orgId = await loadOrgId(run.rubric_id);
  // Tenant onto the ambient log scope (worker/AGENTS.md), so per-row invocation logs filter
  // by org like GEPA's. Runs inside the calling Activity's scope; on a context-cache hit the
  // caller's scope was already patched by whichever Activity resolved the context first.
  setLogContext({ org_id: orgId });
  const { connection } = await loadScheduleConnection(run.schedule_id);
  if (connection.kind !== AGENT_KIND) {
    throw terminal("Eval run's Connection is not an agent");
  }
  const authValue = await getAuthValue(connection);

  // External agent: no managed LLM — just POST the endpoint with authValue.
  if (connection.agent_kind !== "managed") {
    return { connection, authValue, orgId, managed: false, target: null };
  }

  // Managed Agent target key resolution (#292), via the shared provider-call ritual: resolve the
  // key, fail closed on no key, and build the host-pinned provider. The target model stays
  // Anthropic-only on the eval path, resolved independently of the judge, and is validated BEFORE
  // resolution — an unknown/missing target_model can't resolve a meaningful provider at all.
  const targetModel = connection.target_model;
  if (!targetModel || !isAnthropicModel(targetModel)) {
    throw terminal(`Managed Agent has an invalid or missing target_model: ${targetModel ?? "(none)"}`);
  }
  const target = await resolveProviderCall({
    scope: providerScope(evalRunId, orgId),
    resolveKey: () => resolveKeyForModel(supabase, orgId, targetModel),
  });
  return { connection, authValue, orgId, managed: true, target };
}

// agent kind: invoke the Connection's endpoint (or the managed LLM) for one input row and
// persist the output. One Activity per row gives Temporal the retry/fan-out unit the issue asks
// for. Idempotent: a row whose output is already persisted is skipped, so a retried (or
// replayed) invocation never double-spends an agent call.
export async function invokeAgentRow(input: InvokeAgentRowInput): Promise<void> {
  const { evalRunId, rowIndex } = input;

  const { data: row, error: rowError } = await supabase
    .from("eval_run_rows")
    .select("row_index, user_input, agent_output, expected_output, retrieval_context")
    .eq("eval_run_id", evalRunId)
    .eq("row_index", rowIndex)
    .maybeSingle();
  if (rowError) throw new Error(`Failed to load row ${rowIndex}: ${rowError.message}`);
  if (!row) throw terminal(`Input row ${rowIndex} not found`);
  if (typeof row.agent_output === "string" && row.agent_output.trim() !== "") return;

  const ctx = await getAgentRunContext(evalRunId);

  // A Managed Agent runs its stored Module prompt on the managed LLM; an external agent POSTs
  // its endpoint. AgentEndpointError propagates as a plain retryable failure — the proxy's
  // capped retry absorbs blips, and exhaustion fails the run with the real reason.
  if (ctx.managed) {
    // runProviderCall classifies (key attribution + terminal conversion) whatever this callback
    // throws, using the context resolveProviderCall already built once for the whole run
    // (worker/AGENTS.md's per-run agentContextCache).
    await runProviderCall(providerScope(evalRunId, ctx.orgId), ctx.target!, async (target) => {
      const result = await invokeManagedAgent(ctx.connection, row, target.provider);
      await persistAgentOutput(evalRunId, rowIndex, result.text);
    });
  } else {
    const text = await invokeAgent(ctx.connection, row, ctx.authValue);
    await persistAgentOutput(evalRunId, rowIndex, text);
  }
}

async function persistAgentOutput(
  evalRunId: string,
  rowIndex: number,
  output: string
): Promise<void> {
  const { error } = await supabase
    .from("eval_run_rows")
    .update({ agent_output: output })
    .eq("eval_run_id", evalRunId)
    .eq("row_index", rowIndex);
  if (error) throw new Error(`Failed to persist agent output: ${error.message}`);
}

export interface JudgeEvalRunResult {
  overallScore: number;
  rowCount: number;
}

// How many rows each judge checkpoint covers. Inside a chunk evaluateRun fans (row × criterion)
// pairs out at JUDGE_CONCURRENCY, so the chunk must be comfortably larger than the concurrency
// cap for the fan-out to matter; per-chunk upserts keep resume-on-retry granular enough that a
// timed-out Activity loses at most one chunk of judge spend.
const JUDGE_ROW_CHUNK = 20;

// Row/result shapes as selected below (structurally match the evaluator's input row).
interface EvalRowRecord {
  row_index: number;
  user_input: string;
  agent_output: string;
  expected_output: string | null;
  retrieval_context: string | null;
}

interface ExistingResultRecord {
  row_index: number;
  criterion_name: string;
  score: number;
  reasoning: string;
}

// Judge every row against the Rubric and persist the per-criterion scores and reasoning.
// Resolves the judge provider via resolveEvalJudge (saved key or env key) — NOT a bare
// provider. Same evaluateRun the pgmq path calls (which fans every
// (row × criterion) judge call out via mapWithConcurrency at JUDGE_CONCURRENCY, with bounded
// retry), row by row, so results are identical for identical inputs. Checkpointed per row
// (mirrors invokeAgentRow): each row's results are upserted as soon as it is judged and rows
// whose results are already persisted are skipped, so a retried Activity — e.g. one that timed
// out mid-run on a large rubric — resumes where it left off instead of re-spending every LLM
// judge call.
export async function judgeEvalRun(input: { evalRunId: string }): Promise<JudgeEvalRunResult> {
  const { evalRunId } = input;
  const run = await loadEvalRun(evalRunId);
  const orgId = await loadOrgId(run.rubric_id);
  // Tenant onto the ambient log scope (worker/AGENTS.md), so the judge's deep provider/
  // evaluator/settlement logs filter by org like GEPA's.
  setLogContext({ org_id: orgId });
  const rubric = await loadRubric(run.rubric_id);

  // Both reads are paged: rows can reach 10,000 (schedule maxRows) and results
  // rows × criteria — an unpaged select silently truncates at PostgREST's 1,000-row cap,
  // which for the checkpoint read would re-judge everything past the cap on a retried
  // Activity.
  const rows = await selectAllPages<EvalRowRecord>("rows", (from, to) =>
    supabase
      .from("eval_run_rows")
      .select("row_index, user_input, agent_output, expected_output, retrieval_context")
      .eq("eval_run_id", evalRunId)
      .order("row_index", { ascending: true })
      .range(from, to)
  );
  if (!rows.length) throw terminal("No input rows found");

  const existing = await selectAllPages<ExistingResultRecord>("existing results", (from, to) =>
    supabase
      .from("eval_run_results")
      .select("row_index, criterion_name, score, reasoning")
      .eq("eval_run_id", evalRunId)
      .order("row_index", { ascending: true })
      .order("criterion_name", { ascending: true })
      .range(from, to)
  );

  // Merged result set, keyed (row_index, criterion_name) — the same unique key the upsert
  // uses — so a partially-judged row is re-judged whole and overwrites its earlier scores.
  const resultKey = (rowIndex: number, criterionName: string) => `${rowIndex} ${criterionName}`;
  const merged = new Map<string, RowCriterionResult>();
  for (const r of existing ?? []) {
    merged.set(resultKey(r.row_index as number, r.criterion_name as string), {
      rowIndex: r.row_index as number,
      criterionName: r.criterion_name as string,
      score: r.score as number,
      reasoning: r.reasoning as string,
    });
  }

  // Resolve the Workspace's judge key (#204), guard, and judge — all via the shared
  // provider-call ritual (#384). The judge runs on whichever runtime-ready provider has a key
  // (saved key first, then env); no key resolves to "none" and fails closed. The provider client
  // is pinned to the exact model resolved (judgeModel opt). providerCall classifies whatever the
  // callback throws (key attribution + terminal conversion), so a rejected key or a retired model
  // is handled uniformly with every other call site.
  await providerCall({
    scope: providerScope(evalRunId, orgId),
    resolveKey: async () => {
      const { provider, judgeModel, resolved } = await resolveEvalJudge(supabase, orgId);
      return { provider, model: judgeModel, resolved };
    },
    providerOpts: (model) => ({ judgeModel: model }),
    execute: async ({ provider }) => {
      // Judge in multi-row CHUNKS, not row-by-row: evaluateRun fans its (row × criterion) judge
      // calls out at JUDGE_CONCURRENCY, so a single-row call caps concurrency at that one row's
      // criterion count and serializes rows — the old executor's whole-run call was 5-way
      // concurrent across rows. A chunk keeps the checkpoint granularity (each chunk's results
      // are upserted before the next starts, so a timed-out Activity resumes at the first
      // un-judged row) while restoring cross-row fan-out inside the chunk. A partially-judged
      // row is still re-judged whole and overwrites its earlier scores (same key as the upsert).
      const pending = rows.filter(
        (row) => !rubric.criteria.every((c) => merged.has(resultKey(row.row_index, c.name)))
      );
      for (let i = 0; i < pending.length; i += JUDGE_ROW_CHUNK) {
        const chunk = pending.slice(i, i + JUDGE_ROW_CHUNK);
        const { results } = await evaluateRun(rubric, chunk, provider, run.eval_type);

        const { error: resultsError } = await supabase.from("eval_run_results").upsert(
          results.map((r) => ({
            eval_run_id: evalRunId,
            row_index: r.rowIndex,
            criterion_name: r.criterionName,
            score: r.score,
            reasoning: r.reasoning,
          })),
          { onConflict: "eval_run_id,row_index,criterion_name" }
        );
        if (resultsError) throw new Error(`Failed to save results: ${resultsError.message}`);

        for (const r of results) merged.set(resultKey(r.rowIndex, r.criterionName), r);
      }
    },
  });

  // Same weighted average evaluateRun computes, over the merged (resumed + fresh) results.
  const overallScore = computeOverallScore(rubric, [...merged.values()]);
  return { overallScore, rowCount: rows.length };
}

export interface CompleteEvalRunInput {
  evalRunId: string;
  overallScore: number;
  rowCount: number;
}

export async function completeEvalRun(input: CompleteEvalRunInput): Promise<void> {
  const { evalRunId, overallScore, rowCount } = input;
  agentContextCache.delete(evalRunId);

  // The notification below fires only when THIS call actually flipped the status (the guarded
  // transition, settle-terminal-run.ts), so a retried Activity whose earlier attempt already
  // completed the run never re-sends the completion email or re-counts telemetry.
  await settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "completed",
    fromStatuses: FROM_RUNNING,
    patch: { overall_score: overallScore },
    notify: {
      run: async () => {
        const notify = await loadRunNotification(evalRunId);
        if (notify.orgId) setLogContext({ org_id: notify.orgId });
        log.info("Run completed", {
          event: "eval_run.completed",
          run_id: evalRunId,
          overall_score: overallScore,
          row_count: rowCount,
          // Creation → terminal. The old executor measured dequeue → terminal inside one process;
          // on the Temporal path Activities run in separate scopes, so the run row is the only
          // clock that spans the whole run.
          duration_ms: Date.now() - new Date(notify.createdAt).getTime(),
        });
        if (notify.emails.length > 0) {
          await sendCompletionEmail({
            to: notify.emails,
            runId: evalRunId,
            rubricName: notify.rubricName,
            overallScore,
            rowCount,
            appUrl: APP_URL,
          });
        }
        await trackRunCompleted(evalRunId, overallScore, rowCount);
      },
      onError: (err) => {
        log.error("Failed to send eval run completion notification", {
          event: "eval_run.completion_email_failed",
          run_id: evalRunId,
          error: err,
        });
      },
    },
  });
}

export async function failEvalRun(input: { evalRunId: string; message: string }): Promise<void> {
  const { evalRunId, message } = input;
  agentContextCache.delete(evalRunId);

  // Guarded transition (queued/running → failed): a run already in a terminal state stays
  // there. Without the guard, a retried prepareEvalRun whose first attempt marked the run
  // 'skipped' (quiet dataset window) would flip it to failed with a spurious failure email —
  // same for completed runs. The terminal write must be reliable: settleTerminalRun throws on
  // an update error so Temporal retries the Activity — swallowing it would wedge the run as
  // 'running' with only the orphaned-workflow sweep left to recover it eventually.
  await settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "failed",
    fromStatuses: FROM_QUEUED_OR_RUNNING,
    patch: { error_message: message },
    // The failure reaches error tracking too (restored per review follow-up): Postgres remains
    // the source of truth the UI reads, but a systematic failure wave (provider outage,
    // endpoint bug across every scheduled run) must surface in PostHog error tracking, not
    // only in rows customers report. Guarded by the flip (only runs when this call performed
    // the transition), so retries can't double-report.
    afterTransition: () => {
      captureException(new Error(message), { run_id: evalRunId, context: "evalRunFailed" });
    },
    notify: {
      run: async () => {
        const notify = await loadRunNotification(evalRunId);
        if (notify.orgId) setLogContext({ org_id: notify.orgId });
        log.error("Run failed", {
          event: "eval_run.failed",
          run_id: evalRunId,
          error_message: message,
          // Creation → terminal (see completeEvalRun's note on the clock).
          duration_ms: Date.now() - new Date(notify.createdAt).getTime(),
        });
        if (notify.emails.length > 0) {
          await sendFailureEmail({
            to: notify.emails,
            runId: evalRunId,
            rubricName: notify.rubricName,
            errorMessage: message,
            appUrl: APP_URL,
          });
        }
      },
      onError: (err) => {
        log.error("Failed to send eval run failure notification", {
          event: "eval_run.failure_email_failed",
          run_id: evalRunId,
          error: err,
        });
      },
    },
  });
}

// ---- helpers / loaders ----

// A misconfiguration retries cannot fix: surface it as a nonRetryable ApplicationFailure so
// Temporal stops retrying the Activity and the workflow records the reason immediately.
function terminal(message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type: "EvalRunTerminal", nonRetryable: true });
}

interface EvalRunRow {
  id: string;
  rubric_id: string;
  schedule_id: string | null;
  eval_type: string;
}

async function loadEvalRun(evalRunId: string): Promise<EvalRunRow> {
  const { data, error } = await supabase
    .from("eval_runs")
    .select("id, rubric_id, schedule_id, eval_type")
    .eq("id", evalRunId)
    .maybeSingle<EvalRunRow>();
  if (error) throw new Error(`Failed to load eval run: ${error.message}`);
  if (!data) throw terminal("Eval run not found");
  return data;
}

// The owning org for the run (via its Rubric) — the tenant every billing seam is scoped to.
async function loadOrgId(rubricId: string): Promise<string> {
  const { data, error } = await supabase
    .from("rubrics")
    .select("org_id")
    .eq("id", rubricId)
    .maybeSingle<{ org_id: string }>();
  if (error) throw new Error(`Failed to load rubric org: ${error.message}`);
  if (!data) throw terminal("Rubric not found");
  return data.org_id;
}

async function loadRubric(rubricId: string): Promise<Rubric> {
  const { data, error } = await supabase
    .from("rubrics")
    .select("name, scenario_description, expected_outcome, grounding_context, criteria")
    .eq("id", rubricId)
    .maybeSingle<Rubric>();
  if (error) throw new Error(`Failed to load rubric: ${error.message}`);
  if (!data) throw terminal("Rubric not found");
  return data;
}

interface ScheduleSampling {
  connection_id: string;
  window_minutes: number | null;
  max_rows: number | null;
}

// Load a Schedule's sampling config + its Connection. Mirrors the old pgmq worker's loader.
async function loadScheduleConnection(
  scheduleId: string
): Promise<{ schedule: ScheduleSampling; connection: DatasetConnection }> {
  const { data: schedule, error: scheduleError } = await supabase
    .from("schedules")
    .select("connection_id, window_minutes, max_rows")
    .eq("id", scheduleId)
    .maybeSingle();
  if (scheduleError) throw new Error(`Failed to load schedule: ${scheduleError.message}`);
  if (!schedule) throw terminal("Schedule not found for run");

  const { data: connection, error: connectionError } = await supabase
    .from("connections")
    .select(
      "id, kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, config, optimizable_prompts, agent_kind, target_model"
    )
    .eq("id", (schedule as ScheduleSampling).connection_id)
    .maybeSingle();
  if (connectionError) throw new Error(`Failed to load connection: ${connectionError.message}`);
  if (!connection) throw terminal("Connection not found for schedule");

  return { schedule: schedule as ScheduleSampling, connection: connection as DatasetConnection };
}

// Decrypt the Connection's credential (full header value, e.g. "Bearer ..."), if any.
async function getAuthValue(connection: DatasetConnection): Promise<string | null> {
  if (!connection.auth_secret_id) return null;
  const { data, error } = await supabase.rpc("get_connection_auth", {
    p_secret_id: connection.auth_secret_id,
  });
  if (error) throw new Error(`Failed to read Connection credential: ${error.message}`);
  return (data as string) ?? null;
}

// dataset kind: query the source for complete rows over the Schedule's window, keep only
// usable rows, and insert them as eval_run_rows for the shared scoring path. Returns
// whether the run has rows to score. Idempotent: rows already persisted by an earlier
// attempt are reused rather than re-fetched (a retry must not silently switch the run to a
// different time window).
async function resolveDatasetRows(
  evalRunId: string,
  connection: DatasetConnection,
  schedule: ScheduleSampling
): Promise<boolean> {
  const { count: existing, error: countError } = await supabase
    .from("eval_run_rows")
    .select("id", { count: "exact", head: true })
    .eq("eval_run_id", evalRunId);
  if (countError) throw new Error(`Failed to count rows: ${countError.message}`);
  if ((existing ?? 0) > 0) return true;

  const windowMinutes = schedule.window_minutes ?? 60;
  const maxRows = schedule.max_rows ?? 100;
  const end = new Date();
  const start = new Date(end.getTime() - windowMinutes * 60_000);

  const authValue = await getAuthValue(connection);
  const adapter = getDatasetAdapter(connection.provider);
  const fetched = await adapter(connection, {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    maxRows,
    authValue,
  });

  // maxRows is a best-effort pushdown to the source; the slice is the authoritative cap
  // (same contract as the pgmq path).
  const usable = fetched
    .filter((r) => r.user_input?.trim() && r.agent_output?.trim())
    .slice(0, maxRows);
  if (usable.length === 0) return false;

  const { error } = await supabase.from("eval_run_rows").upsert(
    usable.map((r, i) => ({
      eval_run_id: evalRunId,
      row_index: i,
      user_input: r.user_input,
      agent_output: r.agent_output,
      expected_output: r.expected_output,
      retrieval_context: r.retrieval_context,
    })),
    { onConflict: "eval_run_id,row_index" }
  );
  if (error) throw new Error(`Failed to save fetched rows: ${error.message}`);
  return true;
}

// A dataset window with no usable rows: terminal but neither success nor failure. Sends no
// notification email (a normal quiet period, not an alert condition).
async function markSkipped(evalRunId: string, note: string): Promise<void> {
  await settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "skipped",
    fromStatuses: FROM_QUEUED_OR_RUNNING,
    patch: { error_message: note },
  });
}

// Guarded failed-transition WITHOUT the failure email: an orphaned-workflow reap is a
// bookkeeping outcome, not an alert condition (parity with the SQL reaper, which never emailed). Exported for the worker's orphaned-workflow sweep — a plain
// function that also rides the Activity registration re-export harmlessly. Returns whether
// THIS call performed the transition.
export async function failRunQuietly(evalRunId: string, message: string): Promise<boolean> {
  return settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "failed",
    fromStatuses: FROM_QUEUED_OR_RUNNING,
    patch: { error_message: message },
  });
}

interface RunNotificationContext {
  emails: string[];
  rubricName: string;
  createdAt: string;
  orgId: string | null;
}

// Resolve what the terminal-state emails and lifecycle logs need: the run's notification
// recipients, its Rubric's name and org (eval runs carry recipients directly, unlike
// optimization runs — org_id rides the same rubrics join rather than a second query), and its
// creation time (the duration_ms clock on the terminal events).
async function loadRunNotification(evalRunId: string): Promise<RunNotificationContext> {
  const { data: run, error } = await supabase
    .from("eval_runs")
    .select("notification_emails, created_at, rubrics!inner(name, org_id)")
    .eq("id", evalRunId)
    .maybeSingle<{
      notification_emails: string[] | null;
      created_at: string;
      rubrics: { name: string; org_id: string } | { name: string; org_id: string }[];
    }>();
  if (error) throw new Error(`Failed to load run for notification: ${error.message}`);
  if (!run) throw new Error("Eval run not found");

  const rubric = Array.isArray(run.rubrics) ? run.rubrics[0] : run.rubrics;
  return {
    emails: run.notification_emails ?? [],
    rubricName: rubric?.name ?? "your rubric",
    createdAt: run.created_at,
    orgId: rubric?.org_id ?? null,
  };
}
