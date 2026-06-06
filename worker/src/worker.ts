import { createClient } from "@supabase/supabase-js";
import { createServer } from "http";
import { AnthropicProvider } from "./providers/anthropic.js";
import type { LLMProvider } from "./providers/llm.js";
import { evaluateRun } from "./evaluator.js";
import { invokeAgent, type InvokableRow } from "./agent.js";
import { getDatasetAdapter, type DatasetConnection } from "./adapters/index.js";
import { sendCompletionEmail, sendFailureEmail } from "./emailer.js";
import { initTelemetry, trackRunCompleted, captureException } from "./telemetry.js";
import { startTemporalWorker } from "./temporal/worker.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const APP_URL = process.env.APP_URL ?? "https://baseline.app";
const POLL_INTERVAL_MS = 5_000;
// Set WORKER_DEV_MODE=true in .env.local to keep the worker running while developing.
// Default (env var unset or any other value) keeps Fly scale-to-zero behavior.
const MAX_IDLE_POLLS = process.env.WORKER_DEV_MODE === "true" ? Infinity : 6;
const STALE_THRESHOLD_MINUTES = 10;
// Optimization Runs heartbeat updated_at per Activity, so they tolerate (and need) a longer
// window than eval runs — it must exceed a single rollout Activity's 20-min timeout (#90).
const OPT_STALE_THRESHOLD_MINUTES = 30;
const REAP_EVERY_N_POLLS = 12; // ~1 minute at 5s intervals

function createProvider(): LLMProvider {
  const name = process.env.LLM_PROVIDER ?? "anthropic";
  if (name === "anthropic") return new AnthropicProvider();
  throw new Error(`Unknown LLM_PROVIDER: ${name}`);
}

// HTTP wake endpoint — Fly uses incoming traffic as the idle signal.
// Requires WORKER_WAKE_SECRET to match the Authorization: Bearer header.
let idleCount = 0;
let wakeReceived = false;

function startWakeServer() {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  const secret = process.env.WORKER_WAKE_SECRET;
  const server = createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (!secret || auth !== `Bearer ${secret}`) {
      res.writeHead(401).end();
      return;
    }
    idleCount = 0;
    wakeReceived = true;
    res.writeHead(200).end();
  });
  server.listen(port, () => console.log(`Wake endpoint listening on :${port}`));
  return server;
}

async function processMessage(msgId: bigint, runId: string, provider: LLMProvider) {
  const { data: run, error: runError } = await supabase
    .from("eval_runs")
    .select("id, rubric_id, notification_emails, eval_type, schedule_id")
    .eq("id", runId)
    .maybeSingle();

  if (runError || !run) {
    console.error("Failed to fetch run", runId, runError);
    await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
    return;
  }

  const { data: rubric, error: rubricError } = await supabase
    .from("rubrics")
    .select("name, scenario_description, expected_outcome, grounding_context, criteria")
    .eq("id", run.rubric_id)
    .maybeSingle();

  if (rubricError || !rubric) {
    await markFailed(runId, msgId, "Rubric not found");
    return;
  }

  // Atomically claim the run: 'queued' → 'running'.
  // Returns null if another worker already claimed it.
  const { data: claimed } = await supabase
    .from("eval_runs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    console.log(`Run ${runId} already claimed — skipping`);
    return;
  }

  let results: Awaited<ReturnType<typeof evaluateRun>>["results"];
  let overallScore: number;
  let rowCount = 0;

  try {
    // Resolve the rows to score for a scheduled run before loading them:
    //   - dataset kind: no inputs exist yet — fetch complete rows from the source now.
    //   - agent   kind: tick copied the fixed inputs (empty agent_output) — invoke live
    //     (handled after the rows are loaded, below).
    let connection: DatasetConnection | null = null;
    let authValue: string | null = null;
    if (run.schedule_id) {
      const loaded = await loadScheduleConnection(run.schedule_id);
      connection = loaded.connection;
      authValue = await getAuthValue(connection);
      if (connection.kind === "dataset") {
        await resolveDatasetRows(runId, connection, loaded.schedule, authValue);
      }
    }

    const { data: rows, error: rowsError } = await supabase
      .from("eval_run_rows")
      .select("row_index, user_input, agent_output, expected_output, retrieval_context")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true });

    if (rowsError) throw new Error(`Failed to load rows: ${rowsError.message}`);

    // Agent scheduled runs arrive with empty agent_output — invoke the System live and
    // fill the in-memory rows so the evaluator scores the live outputs.
    if (connection?.kind === "agent" && rows?.length) {
      await fillAgentOutputs(runId, connection, rows, authValue);
    }

    if (!rows?.length) {
      // Only a dataset window with no usable rows is a normal quiet period → skip.
      // An agent (or manual) run with no rows means its fixed input set is missing —
      // a real error that should fail and alert, not silently skip.
      if (connection?.kind === "dataset") {
        await markSkipped(runId, msgId, "No rows returned for the configured window");
      } else {
        await markFailed(runId, msgId, "No input rows found");
      }
      return;
    }

    rowCount = rows.length;
    const output = await evaluateRun(
      rubric as Parameters<typeof evaluateRun>[0],
      rows,
      provider,
      run.eval_type
    );
    results = output.results;
    overallScore = output.overallScore;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    captureException(err, { run_id: runId });
    await markFailed(runId, msgId, msg);
    if (run.notification_emails?.length) {
      await sendFailureEmail({
        to: run.notification_emails,
        runId,
        rubricName: rubric.name,
        errorMessage: msg,
        appUrl: APP_URL,
      }).catch(console.error);
    }
    return;
  }

  const { error: insertError } = await supabase.from("eval_run_results").insert(
    results.map((r) => ({
      eval_run_id: runId,
      row_index: r.rowIndex,
      criterion_name: r.criterionName,
      score: r.score,
      reasoning: r.reasoning,
    }))
  );

  if (insertError) {
    console.error("Failed to insert results", insertError);
    await markFailed(runId, msgId, "Failed to save results");
    return;
  }

  await supabase
    .from("eval_runs")
    .update({
      status: "completed",
      overall_score: overallScore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });

  if (run.notification_emails?.length) {
    await sendCompletionEmail({
      to: run.notification_emails,
      runId,
      rubricName: rubric.name,
      overallScore,
      rowCount,
      appUrl: APP_URL,
    }).catch(console.error);
  }

  await trackRunCompleted(runId, overallScore, rowCount);
  console.log(`Run ${runId} completed. Score: ${(overallScore * 100).toFixed(1)}%`);
}

interface ScheduleSampling {
  connection_id: string;
  window_minutes: number | null;
  max_rows: number | null;
}

// Load a Schedule's sampling config + its Connection. Distinguishes a real DB failure
// (permissions/transient) from a genuine miss, so the surfaced error points at the
// actual cause rather than a misleading "not found".
async function loadScheduleConnection(
  scheduleId: string
): Promise<{ schedule: ScheduleSampling; connection: DatasetConnection }> {
  const { data: schedule, error: scheduleError } = await supabase
    .from("schedules")
    .select("connection_id, window_minutes, max_rows")
    .eq("id", scheduleId)
    .maybeSingle();
  if (scheduleError) throw new Error(`Failed to load schedule: ${scheduleError.message}`);
  if (!schedule) throw new Error("Schedule not found for run");

  const { data: connection, error: connectionError } = await supabase
    .from("connections")
    .select(
      "id, kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, config, optimizable_prompts"
    )
    .eq("id", schedule.connection_id)
    .maybeSingle();
  if (connectionError) throw new Error(`Failed to load connection: ${connectionError.message}`);
  if (!connection) throw new Error("Connection not found for schedule");

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

// agent kind: invoke the Connection's endpoint once per row, persist each output, and
// mutate the in-memory rows so the evaluator scores the live outputs.
async function fillAgentOutputs(
  runId: string,
  connection: DatasetConnection,
  rows: Array<InvokableRow & { agent_output: string }>,
  authValue: string | null
): Promise<void> {
  for (const row of rows) {
    // A loaded connection row is a structural superset of AgentConnection, so it passes
    // directly — no cast — and the compiler now verifies the shapes stay compatible.
    const output = await invokeAgent(connection, row, authValue);
    row.agent_output = output;
    await supabase
      .from("eval_run_rows")
      .update({ agent_output: output })
      .eq("eval_run_id", runId)
      .eq("row_index", row.row_index);
  }
}

// dataset kind: query the source for complete rows over the Schedule's window, keep only
// usable rows (both user_input and agent_output present), and insert them as eval_run_rows
// for the shared scoring path. Throws on failure → caught by processMessage.
async function resolveDatasetRows(
  runId: string,
  connection: DatasetConnection,
  schedule: ScheduleSampling,
  authValue: string | null
): Promise<void> {
  const windowMinutes = schedule.window_minutes ?? 60;
  const maxRows = schedule.max_rows ?? 100;
  const end = new Date();
  const start = new Date(end.getTime() - windowMinutes * 60_000);

  const adapter = getDatasetAdapter(connection.provider);
  const fetched = await adapter(connection, {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    maxRows,
    authValue,
  });

  // The adapter passes maxRows to the source ({{max_rows}}), but that's a best-effort
  // pushdown — it only takes effect if the customer's template/HogQL references it. The
  // slice is the authoritative cap so a source that ignores the hint can't blow past it.
  const usable = fetched
    .filter((r) => r.user_input?.trim() && r.agent_output?.trim())
    .slice(0, maxRows);
  if (usable.length === 0) return;

  const { error } = await supabase.from("eval_run_rows").insert(
    usable.map((r, i) => ({
      eval_run_id: runId,
      row_index: i,
      user_input: r.user_input,
      agent_output: r.agent_output,
      expected_output: r.expected_output,
      retrieval_context: r.retrieval_context,
    }))
  );
  if (error) throw new Error(`Failed to save fetched rows: ${error.message}`);
}

async function markFailed(runId: string, msgId: bigint, errorMessage: string) {
  await supabase
    .from("eval_runs")
    .update({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
    .eq("id", runId);
  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
  console.error(`Run ${runId} failed: ${errorMessage}`);
}

// A dataset run whose window yields no usable rows: terminal but neither success nor
// failure. No notification email (it's a normal quiet period, not an alert condition).
async function markSkipped(runId: string, msgId: bigint, note: string) {
  await supabase
    .from("eval_runs")
    .update({ status: "skipped", error_message: note, updated_at: new Date().toISOString() })
    .eq("id", runId);
  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
  console.log(`Run ${runId} skipped: ${note}`);
}

export async function reapStaleRuns() {
  const { data, error } = await supabase.rpc("reap_stale_eval_runs", {
    p_threshold_minutes: STALE_THRESHOLD_MINUTES,
  });
  if (error) {
    captureException(error, { context: "reapStaleRuns" });
    console.error("Stale run reaper error", error);
  } else if (data > 0) {
    console.log(`Reaped ${data} stale run(s)`);
  }
}

// Reap Optimization Runs stranded 'running' by a crashed worker, freeing the org's one-active
// slot (#90). Mirrors reapStaleRuns; failures are logged, never thrown.
export async function reapStaleOptimizationRuns() {
  const { data, error } = await supabase.rpc("reap_stale_optimization_runs", {
    p_threshold_minutes: OPT_STALE_THRESHOLD_MINUTES,
  });
  if (error) {
    captureException(error, { context: "reapStaleOptimizationRuns" });
    console.error("Stale optimization run reaper error", error);
  } else if (data > 0) {
    console.log(`Reaped ${data} stale optimization run(s)`);
  }
}

export async function poll(provider: LLMProvider): Promise<boolean> {
  const { data, error } = await supabase.rpc("dequeue_eval_run_message", {
    vt_seconds: 60,
  });

  if (error) {
    captureException(error, { context: "poll" });
    console.error("Poll error", error);
    return false;
  }

  if (!data || data.length === 0) return false;

  const { msg_id, run_id } = data[0] as { msg_id: bigint; run_id: string };
  console.log(`Processing run ${run_id} (msg ${msg_id})`);
  await processMessage(msg_id, run_id, provider);
  return true;
}

async function main() {
  initTelemetry();
  const provider = createProvider();
  const server = startWakeServer();
  // Coexistence: register a Temporal worker alongside the pgmq poll loop. No-op unless
  // TEMPORAL_ENABLED=true, so existing eval-run/schedule processing is unaffected.
  const temporalWorker = await startTemporalWorker().catch((err) => {
    captureException(err, { context: "startTemporalWorker" });
    console.error("Failed to start Temporal worker", err);
    return null;
  });
  console.log(`Worker started. Provider: ${process.env.LLM_PROVIDER ?? "anthropic"}`);

  let pollCount = 0;
  while (true) {
    if (pollCount % REAP_EVERY_N_POLLS === 0) {
      await reapStaleRuns();
      await reapStaleOptimizationRuns();
    }
    pollCount++;

    const hadWork = await poll(provider).catch((err) => {
      console.error(err);
      return false;
    });

    if (hadWork) {
      idleCount = 0;
    } else {
      idleCount++;
      if (idleCount >= MAX_IDLE_POLLS) {
        console.log(`Queue idle for ${MAX_IDLE_POLLS} consecutive polls — exiting`);
        server.close();
        temporalWorker?.shutdown();
        process.exit(0);
      }
    }

    if (wakeReceived) {
      wakeReceived = false;
      continue;
    }


    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (!process.env.VITEST) {
  main();
}
