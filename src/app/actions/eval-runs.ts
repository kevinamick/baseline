"use server";

import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { EvalRunInputSchema } from "@/lib/validation/schemas";
import type { EvalRun, EvalRunComparison, EvalRunDetails, EvalRunRow, RunComparisonSide } from "@/types/eval-run";

// ---------- Create ----------

export async function createEvalRun(
  rubricId: string,
  rows: EvalRunRow[],
  opts: {
    description?: string;
    notificationEmails?: string[];
    inputSource: string;
  }
): Promise<{ runId: string } | { error: string }> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can run evaluations" };

  const parsed = EvalRunInputSchema.safeParse({ rubricId, rows });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // supabaseAdmin bypasses RLS, so verify rubric belongs to the user's team explicitly.
  const { data: rubric } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", rubricId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!rubric) return { error: "Rubric not found" };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validEmails = (opts.notificationEmails ?? [])
    .filter((e) => EMAIL_RE.test(e))
    .slice(0, 10);

  const { data: run, error: runError } = await supabaseAdmin
    .from("eval_runs")
    .insert({
      created_by: userId,
      rubric_id: rubricId,
      description: opts.description ?? null,
      notification_emails: validEmails,
    })
    .select("id")
    .single();

  if (runError || !run) {
    await log.error("eval_runs insert failed", { event: "eval_run.create_failed", rubric_id: rubricId, org_id: orgId, error: runError });
    return { error: "Failed to create eval run" };
  }

  const { error: rowsError } = await supabaseAdmin.from("eval_run_rows").insert(
    rows.map((row, i) => ({
      eval_run_id: run.id,
      row_index: i,
      user_input: row.userInput,
      agent_output: row.agentOutput,
      expected_output: row.expectedOutput ?? null,
      retrieval_context: row.retrievalContext ?? null,
    }))
  );

  if (rowsError) {
    await log.error("eval_run_rows insert failed", { event: "eval_run.rows_insert_failed", run_id: run.id, error: rowsError });
    await supabaseAdmin.from("eval_runs").delete().eq("id", run.id);
    return { error: "Failed to save input rows" };
  }

  const { error: enqueueError } = await supabaseAdmin.rpc(
    "enqueue_eval_run",
    { run_id: run.id }
  );

  if (enqueueError) {
    await log.error("enqueue_eval_run failed", { event: "eval_run.enqueue_failed", run_id: run.id, error: enqueueError });
    // Don't block the user — run stays 'queued' and can be retried
  } else {
    await log.info("eval run enqueued", {
      event: "eval_run.enqueued",
      run_id: run.id,
      rubric_id: rubricId,
      row_count: rows.length,
    });
    // Nudge the always-on worker to pick up this run without waiting out its poll interval.
    // Fire-and-forget — the worker runs continuously (it no longer scales to zero), so a failed
    // wake just costs up to one poll interval (~5s) of latency, not a stalled run.
    const workerWakeUrl = process.env.WORKER_WAKE_URL;
    const workerWakeSecret = process.env.WORKER_WAKE_SECRET;
    if (workerWakeUrl) {
      fetch(workerWakeUrl, {
        method: "POST",
        ...(workerWakeSecret ? { headers: { Authorization: `Bearer ${workerWakeSecret}` } } : {}),
      }).catch((err) => log.error("Worker wake failed", { event: "eval_run.worker_wake_failed", run_id: run.id, error: err }));
    }
  }


  await track(
    {
      name: "eval_run.created",
      props: {
        rubric_id: rubricId,
        row_count: rows.length,
        input_source: opts.inputSource,
      },
    },
    { userId }
  );

  return { runId: run.id };
}

// ---------- Read ----------

export async function getEvalRuns(rubricId: string): Promise<EvalRun[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  // Verify rubric belongs to the team before listing its runs.
  const { data: rubric } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", rubricId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!rubric) return [];

  const { data } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at"
    )
    .eq("rubric_id", rubricId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((r) => ({
    id: r.id,
    rubricId: r.rubric_id,
    status: r.status,
    evalType: r.eval_type,
    description: r.description,
    notificationEmails: r.notification_emails ?? [],
    overallScore: r.overall_score != null ? Number(r.overall_score) : null,
    errorMessage: r.error_message,
    createdAt: r.created_at,
  }));
}

export async function getEvalRunDetails(
  runId: string
): Promise<EvalRunDetails | null> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  // Join through rubrics to verify team ownership.
  const { data: run } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at, rubrics!inner(org_id)"
    )
    .eq("id", runId)
    .eq("rubrics.org_id", orgId)
    .maybeSingle();

  if (!run) return null;

  const { data: results } = await supabaseAdmin
    .from("eval_run_results")
    .select("row_index, criterion_name, score, reasoning")
    .eq("eval_run_id", runId)
    .order("row_index", { ascending: true })
    .order("criterion_name", { ascending: true });

  return {
    id: run.id,
    rubricId: run.rubric_id,
    status: run.status,
    evalType: run.eval_type,
    description: run.description,
    notificationEmails: run.notification_emails ?? [],
    overallScore: run.overall_score != null ? Number(run.overall_score) : null,
    errorMessage: run.error_message,
    createdAt: run.created_at,
    results: (results ?? []).map((r) => ({
      rowIndex: r.row_index,
      criterionName: r.criterion_name,
      score: Number(r.score),
      reasoning: r.reasoning,
    })),
  };
}

export async function getEvalRunComparison(
  runIdA: string,
  runIdB: string
): Promise<EvalRunComparison | null> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  const fetchRun = async (runId: string) => {
    const { data } = await supabaseAdmin
      .from("eval_runs")
      .select(
        "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at, rubrics!inner(org_id)"
      )
      .eq("id", runId)
      .eq("rubrics.org_id", orgId)
      .maybeSingle();
    return data;
  };

  const runA = await fetchRun(runIdA);
  if (!runA) return null;

  const runB = await fetchRun(runIdB);
  if (!runB) return null;

  if (runA.rubric_id !== runB.rubric_id) return null;

  const fetchRows = async (runId: string) => {
    const { data } = await supabaseAdmin
      .from("eval_run_rows")
      .select("row_index, user_input, agent_output, expected_output")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true });
    return data ?? [];
  };

  const fetchResults = async (runId: string) => {
    const { data } = await supabaseAdmin
      .from("eval_run_results")
      .select("row_index, criterion_name, score, reasoning")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true })
      .order("criterion_name", { ascending: true });
    return data ?? [];
  };

  const [rowsA, rowsB, resultsA, resultsB] = await Promise.all([
    fetchRows(runIdA),
    fetchRows(runIdB),
    fetchResults(runIdA),
    fetchResults(runIdB),
  ]);

  function mapSide(
    run: NonNullable<Awaited<ReturnType<typeof fetchRun>>>,
    rows: Awaited<ReturnType<typeof fetchRows>>,
    results: Awaited<ReturnType<typeof fetchResults>>
  ): RunComparisonSide {
    return {
      id: run.id,
      rubricId: run.rubric_id,
      status: run.status,
      evalType: run.eval_type,
      description: run.description,
      notificationEmails: run.notification_emails ?? [],
      overallScore: run.overall_score != null ? Number(run.overall_score) : null,
      errorMessage: run.error_message,
      createdAt: run.created_at,
      results: results.map((r) => ({
        rowIndex: r.row_index,
        criterionName: r.criterion_name,
        score: Number(r.score),
        reasoning: r.reasoning,
      })),
      rows: rows.map((r) => ({
        rowIndex: r.row_index,
        userInput: r.user_input,
        agentOutput: r.agent_output,
        expectedOutput: r.expected_output ?? null,
      })),
    };
  }

  return {
    runA: mapSide(runA, rowsA, resultsA),
    runB: mapSide(runB, rowsB, resultsB),
  };
}
