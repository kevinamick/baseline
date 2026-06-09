// Eval Run Activities (#123, ADR-0006). All Postgres access for a Temporal-executed Eval
// Run lives here: the Workflow carries only the run id (and row indexes), and these
// Activities read the real rows/rubric and write outputs/results back. They reuse the same
// agent-invocation (invokeAgent), dataset-adapter, evaluation (evaluateRun) and email logic
// the pgmq poll loop and the optimization Rollouts use, so scores and reasoning match the
// pgmq path for the same inputs. Registered into the Temporal worker by re-export from
// temporal/activities.ts. This is plain Node — no sandbox constraints.
//
// Idempotency contract (Activities are at-least-once): the queued→running claim accepts an
// already-running run, dataset rows are only fetched when none exist yet, agent invocations
// skip rows whose output is already persisted, and results are upserts on the
// (eval_run_id, row_index, criterion_name) unique constraint.

import { createClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";
import { AnthropicProvider } from "../providers/anthropic.js";
import { evaluateRun, type Rubric } from "../evaluator.js";
import { invokeAgent } from "../agent.js";
import { getDatasetAdapter, type DatasetConnection } from "../adapters/index.js";
import { sendCompletionEmail, sendFailureEmail } from "../emailer.js";
import { trackRunCompleted } from "../telemetry.js";
import {
  AGENT_KIND,
  DATASET_KIND,
  MANUAL_KIND,
  READY,
  SKIPPED,
  type EvalRunInputKind,
} from "./kind.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Base URL for the run's deep link in terminal-state emails. Mirrors the pgmq worker's APP_URL.
const APP_URL = process.env.APP_URL ?? "https://baseline.app";

// ---- Activities ----

export type PrepareEvalRunResult =
  | { outcome: typeof SKIPPED }
  | { outcome: typeof READY; kind: EvalRunInputKind; rowIndexes: number[] };

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

  // Surface a missing rubric before claiming the run, like the pgmq path does.
  const { data: rubric, error: rubricError } = await supabase
    .from("rubrics")
    .select("id")
    .eq("id", run.rubric_id)
    .maybeSingle();
  if (rubricError) throw new Error(`Failed to load rubric: ${rubricError.message}`);
  if (!rubric) throw terminal("Rubric not found");

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

  const { data: rows, error: rowsError } = await supabase
    .from("eval_run_rows")
    .select("row_index")
    .eq("eval_run_id", evalRunId)
    .order("row_index", { ascending: true });
  if (rowsError) throw new Error(`Failed to load rows: ${rowsError.message}`);

  // An agent (or manual) run with no rows means its fixed input set is missing — a real
  // error that should fail and alert. (A quiet dataset window already returned above.)
  if (!rows?.length) throw terminal("No input rows found");

  return { outcome: READY, kind, rowIndexes: rows.map((r) => r.row_index as number) };
}

export interface InvokeAgentRowInput {
  evalRunId: string;
  rowIndex: number;
}

// agent kind: invoke the Connection's endpoint for one input row and persist the output.
// One Activity per row gives Temporal the retry/fan-out unit the issue asks for. Idempotent:
// a row whose output is already persisted is skipped, so a retried (or replayed) invocation
// never double-spends an agent call.
export async function invokeAgentRow(input: InvokeAgentRowInput): Promise<void> {
  const { evalRunId, rowIndex } = input;
  const run = await loadEvalRun(evalRunId);
  if (!run.schedule_id) throw terminal("Eval run has no schedule — nothing to invoke");
  const { connection } = await loadScheduleConnection(run.schedule_id);
  if (connection.kind !== AGENT_KIND) {
    throw terminal("Eval run's Connection is not an agent");
  }

  const { data: row, error: rowError } = await supabase
    .from("eval_run_rows")
    .select("row_index, user_input, agent_output, expected_output, retrieval_context")
    .eq("eval_run_id", evalRunId)
    .eq("row_index", rowIndex)
    .maybeSingle();
  if (rowError) throw new Error(`Failed to load row ${rowIndex}: ${rowError.message}`);
  if (!row) throw terminal(`Input row ${rowIndex} not found`);
  if (typeof row.agent_output === "string" && row.agent_output.trim() !== "") return;

  const authValue = await getAuthValue(connection);
  // A loaded connection row is a structural superset of AgentConnection (same contract the
  // pgmq path relies on). AgentEndpointError propagates as a plain retryable failure — the
  // proxy's capped retry absorbs blips, and exhaustion fails the run with the real reason.
  const output = await invokeAgent(connection, row, authValue);

  const { error: updateError } = await supabase
    .from("eval_run_rows")
    .update({ agent_output: output })
    .eq("eval_run_id", evalRunId)
    .eq("row_index", rowIndex);
  if (updateError) throw new Error(`Failed to persist agent output: ${updateError.message}`);
}

export interface JudgeEvalRunResult {
  overallScore: number;
  rowCount: number;
}

// Judge every row against the Rubric and persist the per-criterion scores and reasoning.
// Same evaluateRun the pgmq path calls, over the same ordered rows, so results are
// identical for identical inputs. Upsert (not insert) on the run's unique result key makes
// a retried Activity overwrite its own partial work instead of failing on duplicates.
export async function judgeEvalRun(input: { evalRunId: string }): Promise<JudgeEvalRunResult> {
  const { evalRunId } = input;
  const run = await loadEvalRun(evalRunId);
  const rubric = await loadRubric(run.rubric_id);

  const { data: rows, error: rowsError } = await supabase
    .from("eval_run_rows")
    .select("row_index, user_input, agent_output, expected_output, retrieval_context")
    .eq("eval_run_id", evalRunId)
    .order("row_index", { ascending: true });
  if (rowsError) throw new Error(`Failed to load rows: ${rowsError.message}`);
  if (!rows?.length) throw terminal("No input rows found");

  const provider = new AnthropicProvider();
  const { results, overallScore } = await evaluateRun(rubric, rows, provider, run.eval_type);

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

  return { overallScore, rowCount: rows.length };
}

export interface CompleteEvalRunInput {
  evalRunId: string;
  overallScore: number;
  rowCount: number;
}

export async function completeEvalRun(input: CompleteEvalRunInput): Promise<void> {
  const { evalRunId, overallScore, rowCount } = input;
  const { error } = await supabase
    .from("eval_runs")
    .update({
      status: "completed",
      overall_score: overallScore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", evalRunId);
  if (error) throw new Error(`Failed to complete eval run: ${error.message}`);

  // Best-effort: notify + telemetry. A failure here must never fail the terminal
  // transition (it would surface as a retryable Activity error and loop), so wrap and log.
  try {
    const notify = await loadRunNotification(evalRunId);
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
  } catch (err) {
    console.error("Failed to send eval run completion notification", evalRunId, err);
  }
}

export async function failEvalRun(input: { evalRunId: string; message: string }): Promise<void> {
  const { evalRunId, message } = input;
  await supabase
    .from("eval_runs")
    .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
    .eq("id", evalRunId);

  // Best-effort, same contract as completeEvalRun: a send failure is logged, never thrown.
  try {
    const notify = await loadRunNotification(evalRunId);
    if (notify.emails.length > 0) {
      await sendFailureEmail({
        to: notify.emails,
        runId: evalRunId,
        rubricName: notify.rubricName,
        errorMessage: message,
        appUrl: APP_URL,
      });
    }
  } catch (err) {
    console.error("Failed to send eval run failure notification", evalRunId, err);
  }
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

// Load a Schedule's sampling config + its Connection. Mirrors the pgmq worker's loader
// (worker.ts); the duplication retires with the poll loop in the Temporal cutover (#126).
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
      "id, kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, config, optimizable_prompts"
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

// A dataset window with no usable rows: terminal but neither success nor failure. No
// notification email (a normal quiet period, not an alert condition).
async function markSkipped(evalRunId: string, note: string): Promise<void> {
  const { error } = await supabase
    .from("eval_runs")
    .update({ status: "skipped", error_message: note, updated_at: new Date().toISOString() })
    .eq("id", evalRunId);
  if (error) throw new Error(`Failed to mark eval run skipped: ${error.message}`);
}

interface RunNotificationContext {
  emails: string[];
  rubricName: string;
}

// Resolve what the terminal-state emails need: the run's notification recipients and its
// Rubric's name (eval runs carry recipients directly, unlike optimization runs).
async function loadRunNotification(evalRunId: string): Promise<RunNotificationContext> {
  const { data: run, error } = await supabase
    .from("eval_runs")
    .select("notification_emails, rubrics!inner(name)")
    .eq("id", evalRunId)
    .maybeSingle<{
      notification_emails: string[] | null;
      rubrics: { name: string } | { name: string }[];
    }>();
  if (error) throw new Error(`Failed to load run for notification: ${error.message}`);
  if (!run) throw new Error("Eval run not found");

  const rubric = Array.isArray(run.rubrics) ? run.rubrics[0] : run.rubrics;
  return {
    emails: run.notification_emails ?? [],
    rubricName: rubric?.name ?? "your rubric",
  };
}
