"use server";

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import type { EvalRun, EvalRunDetails, EvalRunRow } from "@/types/eval-run";

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
  const { userId } = await auth();
  if (!userId) return { error: "Not authenticated" };

  if (rows.length === 0) return { error: "At least one input row is required" };

  // supabaseAdmin bypasses RLS, so verify rubric ownership explicitly.
  const { data: rubric } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", rubricId)
    .eq("created_by", userId)
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
    console.error("eval_runs insert failed", runError);
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
    console.error("eval_run_rows insert failed", rowsError);
    await supabaseAdmin.from("eval_runs").delete().eq("id", run.id);
    return { error: "Failed to save input rows" };
  }

  const { error: enqueueError } = await supabaseAdmin.rpc(
    "enqueue_eval_run",
    { run_id: run.id }
  );

  if (enqueueError) {
    console.error("enqueue_eval_run failed", enqueueError);
    // Don't block the user — run stays 'queued' and can be retried
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
  const { userId } = await auth();
  if (!userId) return [];

  const { data } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at"
    )
    .eq("rubric_id", rubricId)
    .eq("created_by", userId)
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
  const { userId } = await auth();
  if (!userId) return null;

  const { data: run } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at"
    )
    .eq("id", runId)
    .eq("created_by", userId)
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
