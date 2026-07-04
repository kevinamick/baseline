// Eval Run Activities (#123, ADR-0006). All Postgres access for a Temporal-executed Eval
// Run lives here: the Workflow carries only the run id (and row indexes), and these
// Activities read the real rows/rubric and write outputs/results back. They reuse the same
// agent-invocation (invokeAgent/invokeManagedAgent), dataset-adapter, evaluation (evaluateRun),
// billing (judge/target key resolution, managed metering, claim-time reserve gate, point
// settlement) and email logic the pgmq path used, so scores, spend, and notifications match the
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
//   - The judge Activity resolves the judge provider via resolveEvalJudge (BYO vs managed key)
//     and meters managed judging through createManagedMeter, failing closed on an unpriced
//     managed model or a managed judge with no reservation (#358, ADR-0008).
//   - A Managed Agent's target invocation meters its tokens the same way (#292).
//   - The claim-time reserve gate (claimReserve, #199) runs in prepareEvalRun for scheduled
//     runs, before any metered judging or live agent invocation. Interactive runs reserve at
//     creation (createEvalRun).
//   - Point settlement + managed-reservation release fire on EVERY terminal outcome
//     (complete, fail, skip, and a claim-time billing block).

import { createClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";
import { createProviderForModel } from "../providers/factory.js";
import type { RuntimeProvider } from "../providers/llm.js";
import {
  resolveEvalJudge,
  resolveProviderKey,
  MISSING_PROVIDER_KEY_MESSAGE,
} from "../providers/resolve-key.js";
import {
  createManagedMeter,
  UnpricedManagedCallError,
  ManagedSpendCapExceeded,
  ManagedPaymentBlockedError,
  type ManagedMeter,
} from "../providers/managed-meter.js";
import { classifyProviderError } from "../providers/provider-error.js";
import {
  providerForModel,
  isAnthropicModel,
  priceForModel,
  type LlmProvider,
} from "../providers/registry.js";
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
import { claimReserve, billingBlockedMessage } from "../claim-reserve.js";
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

// Base URL for the run's deep link in terminal-state emails (mirrors the old worker's APP_URL),
// and the host the claim-reserve gate posts back to.
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
// on a managed key re-meter) everything past the cap on every retried Activity.
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

// Claim the run (queued → running), resolve its input rows, and run the claim-time billing
// gate for scheduled runs, mirroring the pgmq path:
//   - manual:  rows were inserted complete at create time — nothing to resolve.
//   - dataset: fetch complete rows from the source over the Schedule's window and persist
//              them; an empty window marks the run 'skipped' (terminal, no email).
//   - agent:   the Schedule copied fixed inputs with empty agent_output — the workflow
//              fans out invokeAgentRow over the returned row indexes next.
// Terminal misconfigurations (run/rubric missing, no input rows for a manual/agent run)
// throw nonRetryable ApplicationFailures: retrying cannot fix them, and the workflow's
// catch records the clear reason on the run. A claim-time billing refusal marks the run
// failed + settles here and returns SKIPPED so the workflow simply completes (no email —
// matches the pgmq path's markFailed for a billing block).
export async function prepareEvalRun(evalRunId: string): Promise<PrepareEvalRunResult> {
  const run = await loadEvalRun(evalRunId);

  // Surface a missing rubric before claiming the run, like the pgmq path does. The org load
  // also patches the tenant onto the ambient log scope (worker/AGENTS.md: `org_id` is patched
  // in via setLogContext once the run/rubric loads).
  const orgId = await loadOrgId(run.rubric_id);
  setLogContext({ org_id: orgId });

  // The judge key gates the whole run (old-executor parity): resolve it BEFORE the claim, the
  // billing reserve, and the agent fan-out, so a run that cannot judge (a Free Team whose BYO
  // key was deleted after scheduling) fails with the clear reason and ZERO agent calls —
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

  // Claim-time billing gate for SCHEDULED runs (#199). tick_schedules inserts scheduled runs
  // with no Point reserve / seat-cap / managed-spend check, so a Team blocked interactively
  // would keep producing runs every tick, unmetered. The rows (and thus the cost) are known
  // now — for both tabular (tick copied them) and dataset (resolveDatasetRows fetched them) —
  // so reserve here, before any metered judging or live agent invocation. Interactive runs are
  // reserved at creation (createEvalRun), so only scheduled runs go through; the app-side gate
  // is idempotent regardless. A refusal marks the run failed + settles and returns SKIPPED so
  // the workflow completes without judging.
  if (run.schedule_id) {
    const decision = await claimReserve(evalRunId, APP_URL);
    if (!decision.allowed) {
      await markBillingBlocked(evalRunId, billingBlockedMessage(decision.reason));
      return { outcome: SKIPPED };
    }
  }

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
  // Managed Agent (#292): the target invocation runs on Baseline's managed LLM through this
  // host-pinned completer, and — when the target key is managed — meters its tokens. An
  // external agent leaves these null and POSTs its endpoint with authValue.
  managed: boolean;
  completer: RuntimeProvider | null;
  meter: ManagedMeter | null;
  // The target LLM key's provider + source, for BYO-failure attribution on a managed agent.
  targetProvider: LlmProvider | null;
  targetSource: "byo" | "managed" | null;
}

// Per-run context for the agent fan-out. The run → schedule → connection resolution, the Vault
// credential decrypt, and (for a Managed Agent) the target-key resolution + meter build are
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

  // External agent: no managed LLM, no metering — just POST the endpoint with authValue.
  if (connection.agent_kind !== "managed") {
    return {
      connection,
      authValue,
      orgId,
      managed: false,
      completer: null,
      meter: null,
      targetProvider: null,
      targetSource: null,
    };
  }

  // Managed Agent target key resolution (#292). The target model stays Anthropic-only on the
  // eval path, resolved independently of the judge. A BYO Anthropic key spends the customer's
  // own tokens (unmetered); the managed key meters at the Plan markup against the reservation
  // the claim gate wrote. Fail closed on: no usable key, a non-Anthropic/absent target model,
  // an unpriced managed model, or a managed target with no reservation.
  try {
    const targetModel = connection.target_model;
    if (!targetModel || !isAnthropicModel(targetModel)) {
      throw terminal(
        `Managed Agent has an invalid or missing target_model: ${targetModel ?? "(none)"}`
      );
    }
    const targetProvider = providerForModel(targetModel);
    const targetResolved = await resolveProviderKey(supabase, orgId, targetProvider);
    if (targetResolved.source === "none") {
      throw terminal(MISSING_PROVIDER_KEY_MESSAGE);
    }
    const targetManaged = targetResolved.source === "managed";
    if (targetManaged && !priceForModel(targetProvider, targetModel)) {
      throw new UnpricedManagedCallError(targetProvider, targetModel);
    }
    const meter = targetManaged
      ? await createManagedMeter(supabase, orgId, { evalRunId })
      : null;
    // Defense-in-depth (#292): a managed-agent run on the managed key MUST carry a managed-spend
    // reservation (the claim gate writes one). A null meter here means no reserve was found —
    // running would burn the dominant target-model spend uncapped/unmetered. Fail closed.
    if (targetManaged && meter === null) {
      throw terminal(
        "Managed Agent run has no managed-spend reservation — refusing to run uncapped."
      );
    }
    const completer = createProviderForModel(targetModel, { apiKey: targetResolved.key });
    return {
      connection,
      authValue,
      orgId,
      managed: true,
      completer,
      meter,
      targetProvider,
      targetSource: targetResolved.source,
    };
  } catch (err) {
    throw asBillingTerminal(err);
  }
}

// agent kind: invoke the Connection's endpoint (or the managed LLM) for one input row and
// persist the output. One Activity per row gives Temporal the retry/fan-out unit the issue asks
// for. Idempotent: a row whose output is already persisted is skipped, so a retried (or
// replayed) invocation never double-spends an agent call. A Managed Agent's target tokens are
// metered when the target key is managed.
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
  try {
    if (ctx.managed) {
      const result = await invokeManagedAgent(ctx.connection, row, ctx.completer!);
      // Persist the output BEFORE metering. record() accrues spend and only then throws on a cap
      // breach, so metering first would drop the output of the very row the customer was charged
      // for. Metering is billing/cap bookkeeping, not validation.
      await persistAgentOutput(evalRunId, rowIndex, result.text);
      if (ctx.meter) {
        try {
          await ctx.meter.record({ usage: result.usage, callKind: "agent" });
        } catch (recordErr) {
          // A cap breach throws AFTER accruing — the spend is counted, keep the output and let
          // the outer catch make it terminal. A TRANSIENT record() failure accrued nothing, and
          // the already-persisted output would make the retried Activity skip this row at the
          // idempotency guard above — silently dropping the row's metering forever. Clear the
          // output so the retry re-invokes and re-meters: erring toward a double-spent agent
          // call over unmetered managed spend, the same direction the pgmq path and GEPA err.
          if (!isTerminalBillingError(recordErr)) {
            await clearAgentOutput(evalRunId, rowIndex).catch((clearErr) => {
              log.error("Failed to clear output after a metering failure — row stays unmetered", {
                event: "eval_run.unmetered_row",
                run_id: evalRunId,
                row_index: rowIndex,
                org_id: ctx.orgId,
                error: clearErr,
              });
            });
          }
          throw recordErr;
        }
      }
    } else {
      const text = await invokeAgent(ctx.connection, row, ctx.authValue);
      await persistAgentOutput(evalRunId, rowIndex, text);
    }
  } catch (err) {
    // Attribute a BYO target-key rejection to the customer (managed agents only).
    logByoEvalKeyFailure(err, {
      source: ctx.targetSource,
      provider: ctx.targetProvider,
      orgId: ctx.orgId,
      runId: evalRunId,
    });
    // A managed cap/payment/unpriced breach won't clear on retry and would keep spending — make
    // it terminal. Endpoint/provider blips stay retryable.
    throw asBillingTerminal(err);
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

// Undo a row's persisted output so the idempotency guard doesn't skip it on retry — only used
// when the output landed but its managed metering didn't (see invokeAgentRow).
async function clearAgentOutput(evalRunId: string, rowIndex: number): Promise<void> {
  const { error } = await supabase
    .from("eval_run_rows")
    .update({ agent_output: "" })
    .eq("eval_run_id", evalRunId)
    .eq("row_index", rowIndex);
  if (error) throw new Error(`Failed to clear agent output: ${error.message}`);
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
// Resolves the judge provider via resolveEvalJudge (BYO vs managed key) and meters managed
// judging — NOT a bare provider. Same evaluateRun the pgmq path calls (which fans every
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
  // which for the checkpoint read would re-judge (and on a managed key re-METER) everything
  // past the cap on a retried Activity.
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

  // Captured for the catch so a BYO provider rejection is attributed to the customer's key.
  let judgeProviderName: LlmProvider | null = null;
  let judgeSource: "byo" | "managed" | null = null;

  try {
    // Resolve the Team's judge key (#204). A Team with a runtime-ready BYO key judges on THAT
    // provider at its own cost (unmetered); a paid Team with no BYO key falls back to the
    // managed Anthropic key (metered); a Free Team with no key resolves to "none" and fails
    // closed. The provider client is pinned to the exact model the key + meter price.
    const { provider: judgeProvider, judgeModel, resolved } = await resolveEvalJudge(
      supabase,
      orgId
    );
    if (resolved.source === "none") throw terminal(MISSING_PROVIDER_KEY_MESSAGE);
    judgeProviderName = judgeProvider;
    judgeSource = resolved.source;

    // Fail closed on an unpriced managed JUDGE model BEFORE any call or reservation lookup —
    // an unpriced managed model must never run (ADR-0008).
    if (resolved.source === "managed" && !priceForModel(judgeProvider, judgeModel)) {
      throw new UnpricedManagedCallError(judgeProvider, judgeModel);
    }
    const provider = createProviderForModel(judgeModel, { apiKey: resolved.key, judgeModel });

    // Build the managed meter for a managed judge (snapshots the run's markup + cap from the
    // reserve row and stops the run at the cap). Null for a BYO/Free run (never metered).
    let meter: ManagedMeter | null = null;
    if (resolved.source === "managed") {
      meter = await createManagedMeter(supabase, orgId, { evalRunId });
      // Defense-in-depth (#358): a managed judge with no reservation would judge uncapped and
      // UNMETERED — the spend never accrues. Fail closed rather than judge for free.
      if (meter === null) {
        throw terminal(
          "Managed judge run has no managed-spend reservation — refusing to run uncapped."
        );
      }
    }
    // Meter judge calls only when the judge key is managed; a BYO judge spends the customer's
    // own tokens and is never metered.
    const judgeMeter = resolved.source === "managed" ? meter ?? undefined : undefined;

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
      const { results } = await evaluateRun(rubric, chunk, provider, run.eval_type, judgeMeter);

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
  } catch (err) {
    // Attribute a BYO judge-key rejection to the customer before classifying the error.
    logByoEvalKeyFailure(err, {
      source: judgeSource,
      provider: judgeProviderName,
      orgId,
      runId: evalRunId,
    });
    // A managed cap/payment/unpriced breach won't clear on retry and would keep spending — make
    // it terminal. Everything else (provider blips, DB errors) stays retryable.
    throw asBillingTerminal(err);
  }

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
  // completed the run never re-sends the completion email or re-counts telemetry. Settlement
  // itself runs on EVERY attempt against the run's REAL terminal status regardless — a worker
  // that dies between the flip and the settle would otherwise skip settlement forever — and
  // throws on failure (settleMustSucceed) so Temporal's Activity retry covers a transient
  // settle error too.
  await settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "completed",
    fromStatuses: FROM_RUNNING,
    patch: { overall_score: overallScore },
    settleMustSucceed: true,
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
  // 'skipped' (quiet dataset window) or 'failed' (billing block) would flip it to failed with a
  // spurious failure email — same for completed runs. The terminal write must be reliable:
  // settleTerminalRun throws on an update error so Temporal retries the Activity — swallowing
  // it would wedge the run as 'running' with only the orphaned-workflow sweep left to recover
  // it eventually.
  await settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "failed",
    fromStatuses: FROM_QUEUED_OR_RUNNING,
    patch: { error_message: message },
    settleMustSucceed: true,
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

// Attribute a runtime provider rejection to the customer's own key when the key in use was
// BYO (source === "byo"), so operators can tell a customer-key failure from a platform one
// (worker/CLAUDE.md invariant; the eval-run mirror of gepa's logByoOptimizationKeyFailure).
// Never logs key material — only provider, org, run, and the HTTP status/error. A managed-key
// failure deliberately stays the generic provider error.
function logByoEvalKeyFailure(
  err: unknown,
  ctx: { source: "byo" | "managed" | null; provider: LlmProvider | null; orgId: string; runId: string }
): void {
  if (ctx.source !== "byo" || !ctx.provider) return;
  const failure = classifyProviderError(err);
  if (!failure) return;
  log.warn("Customer BYO provider key was rejected by the provider", {
    event: "provider_key.byo_failed",
    provider: ctx.provider,
    org_id: ctx.orgId,
    run_id: ctx.runId,
    status: failure.status,
    error: err instanceof Error ? err.message : String(err),
  });
}

// The billing errors that won't clear on retry (and would keep burning managed tokens if
// retried). One definition shared by the terminal-classification rethrow and the metering
// compensation in invokeAgentRow.
function isTerminalBillingError(err: unknown): err is Error {
  return (
    err instanceof ManagedSpendCapExceeded ||
    err instanceof ManagedPaymentBlockedError ||
    err instanceof UnpricedManagedCallError
  );
}

// Convert a known-terminal billing error into a nonRetryable ApplicationFailure: a managed
// spend-cap breach, a payment block, or an unpriced managed model won't clear on retry, and
// retrying would keep burning managed tokens. An ApplicationFailure (our own terminal() throws)
// passes through unchanged; any other error is returned as-is so Temporal retries it.
function asBillingTerminal(err: unknown): unknown {
  if (isTerminalBillingError(err)) {
    return terminal(err.message);
  }
  return err;
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

// A dataset window with no usable rows: terminal but neither success nor failure. Settles the
// reservation (a scheduled run may already have reserved) and sends no notification email (a
// normal quiet period, not an alert condition).
async function markSkipped(evalRunId: string, note: string): Promise<void> {
  await settleTerminalRun({
    runKind: "eval",
    runId: evalRunId,
    outcome: "skipped",
    fromStatuses: FROM_QUEUED_OR_RUNNING,
    patch: { error_message: note },
  });
}

// A claim-time billing refusal for a scheduled run: mark the run failed + settle, no email
// (matches the pgmq path's markFailed for a billing block; the workflow returns on SKIPPED).
// Delegates to failRunQuietly: mechanically identical to the orphaned-workflow reap (guarded
// fail + settle + release, no notify) — there's no distinct DB state or behavior to fork for
// the "billing_blocked" label (TERMINAL_OUTCOMES documents it; this call settles as 'failed',
// same as the reap, since that's the only persisted state either represents).
async function markBillingBlocked(evalRunId: string, message: string): Promise<void> {
  await failRunQuietly(evalRunId, message);
}

// Guarded failed-transition + settlement WITHOUT the failure email: a billing refusal and an
// orphaned-workflow reap are bookkeeping outcomes, not alert conditions (parity with the SQL
// reaper, which never emailed). Exported for the worker's orphaned-workflow sweep — a plain
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
