"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { requireContributor } from "@/lib/auth/require-contributor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { getTemporalClient } from "@/lib/temporal/client";
import { OPTIMIZATION_TASK_QUEUE } from "@/lib/temporal/connection";
import { EvalRunInputSchema } from "@/lib/validation/schemas";
import { firstIssueMessage } from "@/lib/validation/first-issue";
import { evalRunPointCost, evalRunPointsPerRow } from "@/lib/billing/points";
import {
  checkRunPreflight,
  reserveRunOrRefuse,
  localizeRunGateError,
  RUN_KIND,
  KEY_MODE_STRATEGY,
} from "@/lib/billing/run-gate";
import { ESTIMATE_JUDGE_MODEL, ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";
import type { EvalRun, EvalRunComparison, EvalRunDetails, EvalRunRow, RunComparisonSide } from "@/types/eval-run";

// Cap the rubric run-history list. getEvalRuns is polled every 5s while a run is
// active (runs-panel.tsx) and a scheduled rubric accumulates runs indefinitely,
// so the unbounded whole-history read+render is the hottest growth surface here.
// The most-recent window is all the panel needs: the active run and the >=2
// completed runs the compare affordance gates on are always newest-first, and the
// list already shows a retention note (#187). Mirrors the schedules run-history
// .limit(50) on the same eval_runs table; larger here since this is the primary
// browse/compare surface.
const RUBRIC_RUNS_DISPLAY_LIMIT = 100;

// ---------- Create ----------

export interface InsufficientPoints {
  needed: number;
  remaining: number;
}

/**
 * Roll a half-created run back: settle its Point reservation ('skipped' settles
 * 0 and releases everything), release its managed-spend reservation, then
 * delete the row. Both releases must land BEFORE the delete — the delete nulls
 * both ledgers' FKs (`on delete set null`), after which the reservations are
 * unfindable: `release_managed_reservation` looks up by eval_run_id, so a
 * reserve orphaned by an early delete would pin committed managed spend for the
 * whole period. If either release fails, the run row is LEFT IN PLACE: the
 * worker's orphaned-workflow sweep fails workflow-stamped strays (the SQL
 * reaper the un-stamped ones), and the settlement sweeps then release both
 * reservations, so the money self-heals within minutes instead of stranding.
 */
async function rollBackRun(runId: string, orgId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("settle_eval_run_points", {
    p_run_id: runId,
    p_outcome: "skipped",
  });
  if (error) {
    await log.error("reservation release failed — leaving the run for the reaper to settle", {
      event: "eval_run.reservation_release_failed",
      run_id: runId,
      org_id: orgId,
      error,
    });
    return;
  }
  const { error: managedError } = await supabaseAdmin.rpc("release_managed_reservation", {
    p_eval_run_id: runId,
    p_opt_run_id: null,
  });
  if (managedError) {
    await log.error(
      "managed reservation release failed — leaving the run for the reaper to settle",
      {
        event: "eval_run.managed_release_failed",
        run_id: runId,
        org_id: orgId,
        error: managedError,
      }
    );
    return;
  }
  await supabaseAdmin.from("eval_runs").delete().eq("id", runId);
}

export async function createEvalRun(
  rubricId: string,
  rows: EvalRunRow[],
  opts: {
    description?: string;
    notificationEmails?: string[];
    inputSource: string;
  }
): Promise<
  | { runId: string }
  | { error: string; insufficientPoints?: InsufficientPoints }
> {
  const gate = await requireContributor("run evaluations");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;

  const parsed = EvalRunInputSchema.safeParse({ rubricId, rows });
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Invalid input") };
  }

  // Run Gate (#377): seat cap → BYO-key gate (#184, Free has no managed
  // fallback) → managed-payment fail-closed gate (#186, ADR-0008 Meter 2),
  // checked before the run row exists so a refusal never creates one.
  const preflight = await checkRunPreflight({
    runKind: RUN_KIND.eval,
    orgId,
    requireProviderKeyForFreePlan: true,
    managedPaymentCheckProviders: [ESTIMATE_JUDGE_PROVIDER],
  });
  if (!preflight.ok) {
    return { error: await localizeRunGateError(preflight.refusal) };
  }

  // supabaseAdmin bypasses RLS, so verify rubric belongs to the user's team explicitly.
  // Left on the raw client rather than ported to tenantDb(ctx) in #381: PR #397 (Run
  // Gate) is open in parallel and rewrites this function's body around this exact read
  // (its preflight lands immediately above, pre-#397's seat/key/payment inline checks
  // this replaced) — porting here would conflict with that in-flight rewrite. Still
  // org-scoped by the explicit .eq("org_id", orgId) below; pick this up once #397 lands.
  const { data: rubric, error: rubricError } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- org-scoped by the explicit .eq("org_id", orgId); pending tenantDb migration, deferred past #397 (see comment above)
    .from("rubrics")
    .select("id, criteria")
    .eq("id", rubricId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (rubricError) return { error: "Couldn't verify rubric. Please try again." };
  if (!rubric) return { error: "Rubric not found" };

  const criteriaCount = Array.isArray(rubric.criteria) ? rubric.criteria.length : 0;
  const pointCost = evalRunPointCost(rows.length, criteriaCount);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validEmails = (opts.notificationEmails ?? [])
    .slice(0, 50)
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

  // Run Gate (#377): reserve the run's exact Eval Point cost (#180, ADR-0009),
  // then — only if the judge resolves to the managed key (any BYO key for any
  // runtime-ready provider wins, mirroring the worker's resolveEvalJudge; #358) —
  // its estimated Managed Spend Cap term. The run row must exist first (both
  // reservations FK-reference it), so any refusal here rolls it back.
  const reserved = await reserveRunOrRefuse({
    runKind: RUN_KIND.eval,
    orgId,
    userId,
    runId: run.id,
    pointReserve: {
      kind: "eval_points",
      pointCost,
      metadata: {
        row_count: rows.length,
        criteria_count: criteriaCount,
        per_row_cost: evalRunPointsPerRow(criteriaCount),
      },
    },
    managedSpendTerms: [
      {
        keyModeStrategy: KEY_MODE_STRATEGY.judgeAnyByo,
        provider: ESTIMATE_JUDGE_PROVIDER,
        model: ESTIMATE_JUDGE_MODEL,
        volume: rows.length,
        criteriaCount,
      },
    ],
    managedSpendRef: { evalRunId: run.id },
    callbacks: {
      deleteRun: async () => {
        await supabaseAdmin.from("eval_runs").delete().eq("id", run.id);
      },
      rollbackReservations: () => rollBackRun(run.id, orgId),
    },
  });
  if (!reserved.ok) {
    return {
      error: await localizeRunGateError(reserved.refusal),
      ...(reserved.refusal.insufficientPoints
        ? { insufficientPoints: reserved.refusal.insufficientPoints }
        : {}),
    };
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
    await rollBackRun(run.id, orgId);
    return { error: "Failed to save input rows" };
  }

  // Temporal is the sole eval-run execution path (#123, ADR-0006) — no pgmq enqueue, no
  // worker wake. Stamp workflow_id BEFORE starting so the stale-run reaper can never mistake
  // a freshly-started Temporal run (status 'running') for a stuck one; Temporal owns
  // retries/resumption for these runs. Started by string name — workflow code must never
  // enter the Next bundle (it runs only inside the Temporal worker's sandbox). The managed-
  // spend reservation for this interactive run was already made above (reserveManagedSpend),
  // so the workflow's judge Activity finds it and meters against it.
  const workflowId = `eval-${run.id}`;
  const { error: stampError } = await supabaseAdmin
    .from("eval_runs")
    .update({ workflow_id: workflowId })
    .eq("id", run.id);
  if (stampError) {
    await log.error("eval_runs workflow_id stamp failed", {
      event: "eval_run.workflow_stamp_failed",
      run_id: run.id,
      error: stampError,
    });
    // A run that never starts never executes, and leaving it 'queued' would pin its
    // reservation for the whole period. Roll the whole creation back instead.
    await rollBackRun(run.id, orgId);
    return { error: "Failed to start eval run" };
  }
  try {
    const client = await getTemporalClient();
    await client.workflow.start("runEvalWorkflow", {
      taskQueue: OPTIMIZATION_TASK_QUEUE,
      workflowId,
      args: [{ evalRunId: run.id }],
    });
    await log.info("eval run workflow started", {
      event: "eval_run.workflow_started",
      run_id: run.id,
      rubric_id: rubricId,
      row_count: rows.length,
      workflow_id: workflowId,
    });
  } catch (err) {
    // The start RPC can fail after the server actually accepted it (gRPC deadline or a
    // connection drop on the response). Rolling back then would delete the run out from
    // under a live workflow, which would later fail with a misleading "Eval run not found".
    // So look the workflow up before rolling back; when the lookup itself fails the outcome
    // is unknowable and we still roll back — the orphaned workflow fails terminally against
    // the missing row, which is benign, whereas keeping the run would leave it 'queued'
    // forever (workflow_id is stamped, so nothing else will touch it) with a pinned reserve.
    if (await workflowExists(workflowId)) {
      await log.error("Eval run workflow started despite the error — keeping run", {
        event: "eval_run.workflow_start_ambiguous",
        run_id: run.id,
        workflow_id: workflowId,
        error: err,
      });
    } else {
      await log.error("Failed to start eval run workflow", {
        event: "eval_run.workflow_start_failed",
        run_id: run.id,
        error: err,
      });
      await rollBackRun(run.id, orgId);
      return { error: "Failed to start eval run" };
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

  // Refresh /rubrics so the page-level eval-run count (which seeds the derived
  // guided first-run tutorial) reflects this new run — the "Run your first
  // eval" step ticks on creation, with no persisted onboarding state.
  revalidatePath("/rubrics");

  return { runId: run.id };
}

// Whether a workflow with this id exists on the Temporal server — used to disambiguate a
// failed `workflow.start` whose request may still have been accepted server-side. Returns
// false on any lookup failure (including NOT_FOUND); the caller treats false as "safe to
// roll back".
async function workflowExists(workflowId: string): Promise<boolean> {
  try {
    const client = await getTemporalClient();
    await client.workflow.getHandle(workflowId).describe();
    return true;
  } catch {
    return false;
  }
}

// ---------- Read ----------

export async function getEvalRuns(rubricId: string): Promise<EvalRun[]> {
  const ctx = await getAuthContext();
  const { userId, orgId } = ctx;
  if (!userId || !orgId) return [];

  // Verify rubric belongs to the team before listing its runs.
  const { data: rubric, error: rubricError } = await tenantDb(ctx)
    .from("rubrics")
    .select("id")
    .eq("id", rubricId)
    .maybeSingle();

  if (rubricError) throw rubricError;
  if (!rubric) return [];

  const { data, error } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at"
    )
    .eq("rubric_id", rubricId)
    .is("deleted_at", null) // hide runs aged out of the plan's retention window (#187)
    .order("created_at", { ascending: false })
    .limit(RUBRIC_RUNS_DISPLAY_LIMIT);

  if (error) throw error;

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

export async function getRunCriteriaBreakdown(
  runId: string
): Promise<{ name: string; score: number }[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  const { data: run, error: runError } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubrics!inner(org_id)")
    .eq("id", runId)
    .eq("rubrics.org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run is gone from every surface (#187)
    .maybeSingle();

  if (runError) throw runError;
  if (!run) return [];

  const { data: results, error: resultsErr } = await supabaseAdmin
    .from("eval_run_results")
    .select("criterion_name, score")
    .eq("eval_run_id", runId);

  if (resultsErr) throw resultsErr;

  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of results ?? []) {
    const cur = agg.get(r.criterion_name) ?? { sum: 0, n: 0 };
    cur.sum += Number(r.score);
    cur.n += 1;
    agg.set(r.criterion_name, cur);
  }

  return [...agg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { sum, n }]) => ({ name, score: sum / n }));
}

export async function getEvalRunDetails(
  runId: string
): Promise<EvalRunDetails | null> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  // Join through rubrics to verify team ownership.
  const { data: run, error: runError } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at, rubrics!inner(org_id)"
    )
    .eq("id", runId)
    .eq("rubrics.org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run's detail page 404s like any unknown id (#187)
    .maybeSingle();

  if (runError) throw runError;
  if (!run) return null;

  const { data: results, error: resultsErr } = await supabaseAdmin
    .from("eval_run_results")
    .select("row_index, criterion_name, score, reasoning")
    .eq("eval_run_id", runId)
    .order("row_index", { ascending: true })
    .order("criterion_name", { ascending: true });

  if (resultsErr) throw resultsErr;

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
    const { data, error } = await supabaseAdmin
      .from("eval_runs")
      .select(
        "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at, rubrics!inner(org_id)"
      )
      .eq("id", runId)
      .eq("rubrics.org_id", orgId)
      .is("deleted_at", null) // soft-deleted runs can't be compared either (#187)
      .maybeSingle();
    if (error) throw error;
    return data;
  };

  const [runA, runB] = await Promise.all([
    fetchRun(runIdA),
    fetchRun(runIdB),
  ]);
  if (!runA || !runB) return null;

  if (runA.rubric_id !== runB.rubric_id) return null;

  const fetchRows = async (runId: string) => {
    const { data, error } = await supabaseAdmin
      .from("eval_run_rows")
      .select("row_index, user_input, agent_output, expected_output")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true });
    if (error) throw error;
    return data ?? [];
  };

  const fetchResults = async (runId: string) => {
    const { data, error } = await supabaseAdmin
      .from("eval_run_results")
      .select("row_index, criterion_name, score, reasoning")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true })
      .order("criterion_name", { ascending: true });
    if (error) throw error;
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
