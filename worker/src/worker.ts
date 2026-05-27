import { createClient } from "@supabase/supabase-js";
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

function createProvider(): LLMProvider {
  const name = process.env.LLM_PROVIDER ?? "anthropic";
  if (name === "anthropic") return new AnthropicProvider();
  throw new Error(`Unknown LLM_PROVIDER: ${name}`);
}

async function processMessage(msgId: bigint, runId: string, provider: LLMProvider) {
  // Fetch run + rubric + rows
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

  // Atomically claim the run by transitioning 'queued' → 'running'.
  // If another worker already claimed it the update matches no rows and we
  // get null back. In that case we return without acking so the owning worker
  // can ack when it finishes (or the VT expires and pgmq redelivers).
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

  // Insert results
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

  // Mark completed
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

async function poll(provider: LLMProvider) {
  const { data, error } = await supabase.rpc("dequeue_eval_run_message", {
    vt_seconds: 60,
  });

  if (error) {
    captureException(error, { context: "poll" });
    console.error("Poll error", error);
    return;
  }

  if (!data || data.length === 0) return;

  const { msg_id, run_id } = data[0] as { msg_id: bigint; run_id: string };
  console.log(`Processing run ${run_id} (msg ${msg_id})`);
  await processMessage(msg_id, run_id, provider);
}

async function main() {
  initTelemetry();
  const provider = createProvider();
  console.log(`Worker started. Provider: ${process.env.LLM_PROVIDER ?? "anthropic"}`);

  while (true) {
    await poll(provider).catch(console.error);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
