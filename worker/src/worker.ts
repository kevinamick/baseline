import { createClient } from "@supabase/supabase-js";
import { createServer } from "http";
import { createProviderForModel } from "./providers/factory.js";
import type { RuntimeProvider } from "./providers/llm.js";
import type { TokenUsage } from "./providers/llm.js";
import {
  resolveProviderKey,
  resolveEvalJudge,
  MISSING_PROVIDER_KEY_MESSAGE,
} from "./providers/resolve-key.js";
import { providerForModel, isAnthropicModel } from "./providers/models.js";
import { isLlmProvider } from "./providers/provider-list.js";
import {
  createManagedMeter,
  UnpricedManagedCallError,
  type ManagedMeter,
} from "./providers/managed-meter.js";
import { priceForModel } from "./providers/model-prices.js";
import { evaluateRun } from "./evaluator.js";
import { invokeAgent, invokeManagedAgent, type InvokableRow } from "./agent.js";
import { getDatasetAdapter, type DatasetConnection } from "./adapters/index.js";
import { sendCompletionEmail, sendFailureEmail } from "./emailer.js";
import { initTelemetry, trackRunCompleted, captureException } from "./telemetry.js";
import { log, shutdownLogging } from "./log.js";
import { claimReserve, billingBlockedMessage } from "./claim-reserve.js";
import { startTemporalWorker } from "./temporal/worker.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const APP_URL = process.env.APP_URL ?? "https://baseline.app";
const POLL_INTERVAL_MS = 5_000;
// The worker runs always-on (no idle-exit, no scale-to-zero). Temporal's model is pull-based:
// the worker dials Temporal and long-polls its task queues — nothing external can wake a
// stopped worker. A worker that self-exits on idle would silently stall every Temporal-driven
// workflow until the next inbound HTTP wake, which Temporal never sends. So the process must
// stay up. See ADR-0006 and worker/fly.toml. (The pgmq wake endpoint below is a separate,
// soon-to-be-retired mechanism that only helps the legacy eval-run poll loop pick up promptly.)
const STALE_THRESHOLD_MINUTES = 10;
// Optimization Runs heartbeat updated_at per Activity, so they tolerate (and need) a longer
// window than eval runs — it must exceed a single rollout Activity's 20-min timeout (#90).
const OPT_STALE_THRESHOLD_MINUTES = 30;
const REAP_EVERY_N_POLLS = 12; // ~1 minute at 5s intervals

// HTTP wake endpoint — lets the app server nudge the legacy pgmq poll loop to pick up new
// eval-run work without waiting out the poll interval. Requires WORKER_WAKE_SECRET to match
// the Authorization: Bearer header. (Retired alongside the pgmq loop in the Temporal cutover.)
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
    wakeReceived = true;
    res.writeHead(200).end();
  });
  server.listen(port, () =>
    log.info("Wake endpoint listening", { event: "worker.wake_listening", port })
  );
  return server;
}

async function processMessage(msgId: bigint, runId: string) {
  const { data: run, error: runError } = await supabase
    .from("eval_runs")
    .select("id, rubric_id, notification_emails, eval_type, schedule_id")
    .eq("id", runId)
    .maybeSingle();

  if (runError || !run) {
    log.error("Failed to fetch run", { event: "eval_run.fetch_failed", run_id: runId, error: runError });
    await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
    return;
  }

  const { data: rubric, error: rubricError } = await supabase
    .from("rubrics")
    .select("org_id, name, scenario_description, expected_outcome, grounding_context, criteria")
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
    log.info("Run already claimed — skipping", {
      event: "eval_run.claim_skipped",
      run_id: runId,
      schedule_id: run.schedule_id,
    });
    return;
  }

  let results: Awaited<ReturnType<typeof evaluateRun>>["results"];
  let overallScore: number;
  let rowCount = 0;

  try {
    // Resolve the Team's LLM key for this run (#184, #204). Eval runs carry no per-run model, so
    // the judge is provider-aware via the Team's keys (resolveEvalJudge): a Team that brought its
    // own runtime-ready key judges on THAT provider, at its own cost (a Free Team with only an
    // OpenAI key judges on OpenAI); a paid Team with no BYO key falls back to the managed Anthropic
    // key (the platform bears the cost, so managed judging pins to Anthropic). "none" → fail the
    // run loudly (the catch emails the Contributors), never silently fall back to a platform key.
    // The provider client is picked by the resolved judge model via the factory, pinned to the
    // exact model the key + meter price.
    const { provider: judgeProvider, judgeModel, resolved } = await resolveEvalJudge(
      supabase,
      rubric.org_id as string
    );
    if (resolved.source === "none") {
      throw new Error(MISSING_PROVIDER_KEY_MESSAGE);
    }
    const provider = createProviderForModel(judgeModel, { apiKey: resolved.key, judgeModel });

    // Managed-token metering (#185): only managed runs are metered (BYO runs spend the
    // customer's own tokens). Fail closed on an unpriced managed JUDGE model FIRST — before
    // any reservation or call — independent of whether a reservation exists (schedule-spawned
    // runs are unmetered today like points, so the meter can legitimately be null, but an
    // unpriced managed model must never run regardless, ADR-0008). The meter itself is built
    // AFTER the claim reserve below, so a managed-agent run's claim-time reservation (#292) is
    // visible to it.
    let meter: ManagedMeter | null = null;
    if (resolved.source === "managed" && !priceForModel(judgeProvider, judgeModel)) {
      throw new UnpricedManagedCallError(judgeProvider, judgeModel);
    }

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

    // Claim-time billing gate for scheduled runs (#199). tick_schedules inserts
    // scheduled runs with no Point reserve / seat-cap check, so a Team blocked
    // interactively would keep producing runs every tick, unmetered. The rows (and
    // thus the cost) are known now — for both tabular (tick copied them) and dataset
    // (resolveDatasetRows fetched them above) — so reserve here, before any metered
    // judging or live agent invocation. Interactive runs are reserved at creation, so
    // only scheduled runs go through; the app-side gate is idempotent regardless.
    if (run.schedule_id && rows?.length) {
      const decision = await claimReserve(runId, APP_URL);
      if (!decision.allowed) {
        await markFailed(runId, msgId, billingBlockedMessage(decision.reason));
        return;
      }
    }

    // Resolve the Managed Agent target's key independently of the judge (#204). The target model
    // stays Anthropic-only on this legacy eval path, so it resolves Anthropic — which may now
    // differ from the provider-aware judge (a paid Team judging on a BYO OpenAI key still runs its
    // managed-agent target on the managed Anthropic key). Reuse the judge's resolution when the
    // providers match to avoid a second lookup. Gated on rows?.length to match the claim gate
    // (which only reserves when rows exist) and so an empty-rows run reaches the "No input rows
    // found" branch below with its real reason rather than tripping the no-reservation guard.
    const isManagedAgentRun =
      connection?.kind === "agent" && connection.agent_kind === "managed" && !!rows?.length;
    let targetKey: string | null = null;
    let targetManaged = false;
    if (isManagedAgentRun) {
      const targetModel = connection!.target_model;
      if (!targetModel || !isAnthropicModel(targetModel)) {
        throw new Error(
          `Managed Agent has an invalid or missing target_model: ${targetModel ?? "(none)"}`
        );
      }
      const targetProvider = providerForModel(targetModel);
      const targetResolved =
        targetProvider === judgeProvider
          ? resolved
          : await resolveProviderKey(supabase, rubric.org_id as string, targetProvider);
      if (targetResolved.source === "none") {
        throw new Error(MISSING_PROVIDER_KEY_MESSAGE);
      }
      targetKey = targetResolved.key;
      targetManaged = targetResolved.source === "managed";
      // Fail closed on an unpriced managed target model before any call (mirrors the judge check).
      if (targetManaged && !priceForModel(targetProvider, targetModel)) {
        throw new UnpricedManagedCallError(targetProvider, targetModel);
      }
    }

    // Build the managed meter now that any claim-time reservation exists (#199/#292): it snapshots
    // the run's markup + cap from the reserve row and stops the run if the Managed Spend Cap is
    // reached. Built when EITHER the judge or the managed-agent target resolves to a managed key;
    // null for a fully-BYO/Free run (unmetered, the customer's own tokens).
    if (resolved.source === "managed" || targetManaged) {
      meter = await createManagedMeter(supabase, rubric.org_id as string, { evalRunId: runId });
    }

    // Managed Agent (#292): the System is Baseline's managed LLM. Build a host-pinned completer
    // (#222) on the target's resolved key. resolve-key → none already failed the run above.
    let managedCompleter: RuntimeProvider | null = null;
    if (isManagedAgentRun) {
      // Defense-in-depth (#292): a managed-agent run on the managed key MUST carry a managed-spend
      // reservation (the claim gate writes one). A null meter when the target is managed means no
      // reserve was found — a claim-gate/key-resolver divergence or a redelivered claim that
      // skipped it — so running would burn the dominant target-model spend uncapped/unmetered.
      // Fail closed; a fresh claim on the next tick reserves properly. (A BYO-keyed target run
      // resolves to targetManaged === false and is unmetered.)
      if (targetManaged && meter === null) {
        throw new Error(
          "Managed Agent run has no managed-spend reservation — refusing to run uncapped. It will retry on the next schedule."
        );
      }
      managedCompleter = createProviderForModel(connection!.target_model!, { apiKey: targetKey! });
    }

    // Agent scheduled runs arrive with empty agent_output — invoke the System live and
    // fill the in-memory rows so the evaluator scores the live outputs. A Managed Agent runs
    // its stored prompt on the managed LLM; meter its target tokens only when the target key is
    // managed (a BYO-keyed target spends the customer's own tokens — never metered). An external
    // agent POSTs its endpoint.
    if (connection?.kind === "agent" && rows?.length) {
      await fillAgentOutputs(
        runId,
        connection,
        rows,
        authValue,
        managedCompleter,
        targetManaged ? meter : null
      );
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
    // Meter the judge calls only when the judge key is managed; a BYO judge (the Team's own
    // provider key) spends the customer's own tokens and is never metered, even when a managed-
    // agent target on the same run is metered through `meter`.
    const judgeMeter = resolved.source === "managed" ? meter ?? undefined : undefined;
    const output = await evaluateRun(
      rubric as Parameters<typeof evaluateRun>[0],
      rows,
      provider,
      run.eval_type,
      judgeMeter
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
      }).catch((e) =>
        log.error("Failed to send failure email", {
          event: "eval_run.failure_email_failed",
          run_id: runId,
          error: e,
        })
      );
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
    log.error("Failed to insert results", {
      event: "eval_run.results_insert_failed",
      run_id: runId,
      error: insertError,
    });
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

  await settlePoints(runId, "completed");
  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });

  if (run.notification_emails?.length) {
    await sendCompletionEmail({
      to: run.notification_emails,
      runId,
      rubricName: rubric.name,
      overallScore,
      rowCount,
      appUrl: APP_URL,
    }).catch((e) =>
      log.error("Failed to send completion email", {
        event: "eval_run.completion_email_failed",
        run_id: runId,
        error: e,
      })
    );
  }

  await trackRunCompleted(runId, overallScore, rowCount);
  log.info("Run completed", {
    event: "eval_run.completed",
    run_id: runId,
    schedule_id: run.schedule_id,
    score: overallScore,
    row_count: rowCount,
  });
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
      "id, kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, config, optimizable_prompts, agent_kind, target_model"
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

// agent kind: produce each row's agent_output by invoking the System once per row, persist it,
// and mutate the in-memory rows so the evaluator scores the live outputs. An external agent POSTs
// its endpoint; a Managed Agent (#292) runs its stored Module prompt as-is on Baseline's managed
// LLM (no candidate/evolution — eval runs don't tune the prompt) and meters the target-model
// tokens at the Plan markup (null meter = BYO/unmetered, mirroring resolve-key and the judge path).
async function fillAgentOutputs(
  runId: string,
  connection: DatasetConnection,
  rows: Array<InvokableRow & { agent_output: string }>,
  authValue: string | null,
  managedCompleter: RuntimeProvider | null,
  meter: ManagedMeter | null
): Promise<void> {
  const managed = connection.agent_kind === "managed";
  for (const row of rows) {
    // The loaded connection row is a structural superset of AgentConnection, so it passes directly
    // — no cast. A Managed Agent runs its stored seed prompt (no candidate); an external agent POSTs
    // its endpoint.
    let output: string;
    let usage: TokenUsage | undefined;
    if (managed) {
      const result = await invokeManagedAgent(connection, row, managedCompleter!);
      output = result.text;
      usage = result.usage;
    } else {
      output = await invokeAgent(connection, row, authValue);
    }

    // Persist the output BEFORE metering. record() accrues spend and only then throws on a cap
    // breach, so metering first would drop the output of the very row the customer was charged for
    // (the run aborts via the outer catch). Metering is billing/cap bookkeeping, not validation.
    row.agent_output = output;
    await supabase
      .from("eval_run_rows")
      .update({ agent_output: output })
      .eq("eval_run_id", runId)
      .eq("row_index", row.row_index);

    if (managed && meter) await meter.record({ usage, callKind: "agent" });
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

// Settle the run's Eval Point reservation at its terminal state (#180,
// ADR-0009). Idempotent in Postgres and a no-op for unmetered runs, so it is
// safe on every terminal path including pgmq redeliveries. Never fatal: a
// settlement hiccup must not take down run processing — the released points
// are recovered by re-settling, not by failing the run.
async function settlePoints(runId: string, outcome: "completed" | "failed" | "skipped") {
  const { error } = await supabase.rpc("settle_eval_run_points", {
    p_run_id: runId,
    p_outcome: outcome,
  });
  if (error) {
    log.error("Point settlement failed", {
      event: "eval_run.settle_failed",
      run_id: runId,
      outcome,
      error,
    });
  }
  // Release the run's managed-spend reservation (#185) so committed spend
  // converges to accrued actuals. Idempotent and a no-op for BYO/unmetered runs
  // (no reservation row). Never fatal — a release hiccup must not fail the run.
  const { error: relErr } = await supabase.rpc("release_managed_reservation", {
    p_eval_run_id: runId,
    p_opt_run_id: null,
  });
  if (relErr) {
    log.error("Managed reservation release failed", {
      event: "managed_spend.release_failed",
      run_id: runId,
      error: relErr,
    });
  }
}

async function markFailed(runId: string, msgId: bigint, errorMessage: string) {
  await supabase
    .from("eval_runs")
    .update({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
    .eq("id", runId);
  await settlePoints(runId, "failed");
  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
  log.error("Run failed", { event: "eval_run.failed", run_id: runId, error: errorMessage });
}

// A dataset run whose window yields no usable rows: terminal but neither success nor
// failure. No notification email (it's a normal quiet period, not an alert condition).
async function markSkipped(runId: string, msgId: bigint, note: string) {
  await supabase
    .from("eval_runs")
    .update({ status: "skipped", error_message: note, updated_at: new Date().toISOString() })
    .eq("id", runId);
  await settlePoints(runId, "skipped");
  await supabase.rpc("ack_eval_run_message", { p_msg_id: msgId });
  log.info("Run skipped", { event: "eval_run.skipped", run_id: runId, note });
}

export async function reapStaleRuns() {
  const { data, error } = await supabase.rpc("reap_stale_eval_runs", {
    p_threshold_minutes: STALE_THRESHOLD_MINUTES,
  });
  if (error) {
    captureException(error, { context: "reapStaleRuns" });
    log.error("Stale run reaper error", { event: "eval_run.reap_failed", error });
  } else if (data > 0) {
    log.info("Reaped stale eval run(s)", { event: "eval_run.reaped", count: data });
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
    log.error("Stale optimization run reaper error", {
      event: "optimization_run.reap_failed",
      error,
    });
  } else if (data > 0) {
    log.info("Reaped stale optimization run(s)", {
      event: "optimization_run.reaped",
      count: data,
    });
  }
}

export async function poll(): Promise<boolean> {
  const { data, error } = await supabase.rpc("dequeue_eval_run_message", {
    vt_seconds: 60,
  });

  if (error) {
    captureException(error, { context: "poll" });
    log.error("Poll error", { event: "worker.poll_failed", error });
    return false;
  }

  if (!data || data.length === 0) return false;

  const { msg_id, run_id } = data[0] as { msg_id: bigint; run_id: string };
  log.info("Processing run", {
    event: "eval_run.dequeued",
    run_id,
    msg_id: String(msg_id),
  });
  await processMessage(msg_id, run_id);
  return true;
}

async function main() {
  initTelemetry();
  // Fail fast on a misconfigured LLM_PROVIDER name (the per-run providers are
  // built later, each with the Team's resolved key).
  const providerName = process.env.LLM_PROVIDER ?? "anthropic";
  if (!isLlmProvider(providerName)) {
    throw new Error(`Unknown LLM_PROVIDER: ${providerName}`);
  }
  const server = startWakeServer();
  // Coexistence: register a Temporal worker alongside the pgmq poll loop. No-op unless
  // TEMPORAL_ENABLED=true, so existing eval-run/schedule processing is unaffected.
  const temporalWorker = await startTemporalWorker().catch((err) => {
    captureException(err, { context: "startTemporalWorker" });
    log.error("Failed to start Temporal worker", {
      event: "temporal.worker_start_failed",
      error: err,
    });
    return null;
  });
  log.info("Worker started", {
    event: "worker.started",
    provider: process.env.LLM_PROVIDER ?? "anthropic",
    temporal_enabled: temporalWorker != null,
  });

  // The worker no longer self-exits on idle, so a deploy/restart (Fly sends SIGINT/SIGTERM) is
  // now the normal way it goes down. Shut down cleanly so Temporal sees the worker leave its
  // task queue and drains in-flight activities, rather than being killed mid-rollout. A hard
  // timeout guarantees we exit even if a drain hangs (Fly SIGKILLs after its grace period anyway).
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("Shutdown signal received — shutting down", {
        event: "worker.shutdown",
        signal,
      });
      const forceExit = setTimeout(() => process.exit(0), 10_000);
      forceExit.unref();
      server.close();
      Promise.resolve(temporalWorker?.shutdown())
        .catch((err) =>
          log.error("Temporal worker shutdown failed", {
            event: "temporal.worker_shutdown_failed",
            error: err,
          })
        )
        // Drain buffered PostHog log records before the process exits.
        .then(() => shutdownLogging())
        .finally(() => process.exit(0));
    });
  }

  let pollCount = 0;
  while (!shuttingDown) {
    if (pollCount % REAP_EVERY_N_POLLS === 0) {
      await reapStaleRuns();
      await reapStaleOptimizationRuns();
    }
    pollCount++;

    // Stop claiming new pgmq work once shutdown has begun, so we don't start a run the
    // process is about to exit mid-flight (the shutdown handler drains in-flight work).
    if (shuttingDown) break;
    await poll().catch((err) => {
      // Swallow so a transient DB error can't crash the always-on loop. Return value unused.
      log.error("Poll loop error", { event: "worker.poll_loop_error", error: err });
    });

    // Skip the poll-interval wait when the app server has signalled new work.
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
