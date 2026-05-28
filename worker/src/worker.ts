import { createClient } from "@supabase/supabase-js";
import { createServer } from "http";
import { AnthropicProvider } from "./providers/anthropic.js";
import type { LLMProvider } from "./providers/llm.js";
import { evaluateRun } from "./evaluator.js";
import { sendCompletionEmail, sendFailureEmail } from "./emailer.js";
import { initTelemetry, trackRunCompleted, captureException } from "./telemetry.js";

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
    .select("id, rubric_id, notification_emails, eval_type")
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

  const { data: rows, error: rowsError } = await supabase
    .from("eval_run_rows")
    .select("row_index, user_input, agent_output, expected_output, retrieval_context")
    .eq("eval_run_id", runId)
    .order("row_index", { ascending: true });

  if (rowsError || !rows?.length) {
    await markFailed(runId, msgId, "No input rows found");
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

  try {
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
      rowCount: rows.length,
      appUrl: APP_URL,
    }).catch(console.error);
  }

  await trackRunCompleted(runId, overallScore, rows.length);
  console.log(`Run ${runId} completed. Score: ${(overallScore * 100).toFixed(1)}%`);
}

async function markFailed(runId: string, msgId: bigint, errorMessage: string) {
  await supabase
    .from("eval_runs")
    .update({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
    .eq("id", runId);
  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
  console.error(`Run ${runId} failed: ${errorMessage}`);
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
  console.log(`Worker started. Provider: ${process.env.LLM_PROVIDER ?? "anthropic"}`);

  let pollCount = 0;
  while (true) {
    if (pollCount % REAP_EVERY_N_POLLS === 0) {
      await reapStaleRuns();
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
