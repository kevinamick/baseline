"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { getTemporalClient } from "@/lib/temporal/client";
import { OPTIMIZATION_TASK_QUEUE } from "@/lib/temporal/connection";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";
import { insertConnection } from "@/lib/connections/create";
import {
  overallScoreFromResults,
  type ScoredCriterion,
  type CriterionResult,
} from "@/lib/optimization/score";
import {
  ACTIVE_OPTIMIZATION_STATUSES,
  isActiveOptimizationStatus,
  type OptimizationRunStatus,
  type OptimizationRunSummary,
} from "@/types/optimization";

// The Pareto phase scores a Candidate on the full frozen set (vs the cheap accept/reject
// 'minibatch'); a Candidate's overall score is derived from these rollouts.
const PARETO_PHASE = "pareto";

// ---------- Start ----------

// Start a manual, one-shot Optimization Run (#87). Authz (Contributor), snapshot the manual
// instances into a frozen set, enforce one active run per org, then start the durable
// Temporal workflow. Per ADR-0006 the workflow carries only the run id — Activities read the
// prompts/instances and write rollouts/results back to Postgres.
export async function startOptimizationRun(
  input: z.input<typeof CreateOptimizationRunSchema>
): Promise<{ optRunId: string } | { error: string }> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can start optimization runs" };

  const parsed = CreateOptimizationRunSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid optimization run" };
  }
  const o = parsed.data;

  // Verify the rubric belongs to the team.
  const { data: rubric } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", o.rubricId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!rubric) return { error: "Rubric not found" };

  // Resolve the agent Connection: an existing one (verify ownership + agent kind) or create one
  // inline from the wizard's System step (#108). A Connection created here is rolled back if the
  // run can't be started, so a failed start never leaves an orphan Connection behind.
  let connectionId: string;
  let createdConnectionId: string | null = null;
  if (o.newConnection) {
    const created = await insertConnection(orgId, userId, o.newConnection);
    if ("error" in created) return { error: created.error };
    connectionId = created.connectionId;
    createdConnectionId = created.connectionId;
  } else if (o.connectionId) {
    // Only agents expose the {{prompt:*}} Modules an optimization run tunes.
    const { data: connection } = await supabaseAdmin
      .from("connections")
      .select("id, kind, optimizable_prompts")
      .eq("id", o.connectionId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!connection) return { error: "Connection not found" };
    if (connection.kind !== "agent") {
      return { error: "Optimization requires an agent connection" };
    }
    // The wizard hides Module-less connections, but be authoritative here too: with no Modules
    // there's nothing to tune — the loop would no-op on the seed and waste a rollout. (A
    // connection's Modules can also be removed after the list was rendered.)
    const moduleCount = Array.isArray(connection.optimizable_prompts)
      ? connection.optimizable_prompts.length
      : 0;
    if (moduleCount === 0) {
      return {
        error: "This agent connection has no optimizable Modules — add at least one to optimize it.",
      };
    }
    connectionId = connection.id;
  } else {
    return { error: "Select or create an agent connection" };
  }

  const cleanupCreatedConnection = async () => {
    if (createdConnectionId) {
      await supabaseAdmin.from("connections").delete().eq("id", createdConnectionId);
    }
  };

  // Insert the run as queued. The partial unique index (one active run per org) rejects a
  // concurrent second start with a 23505 — surface that as a friendly message.
  const { data: run, error: runErr } = await supabaseAdmin
    .from("optimization_runs")
    .insert({
      org_id: orgId,
      created_by: userId,
      connection_id: connectionId,
      rubric_id: o.rubricId,
      eval_type: o.evalType,
      budget_rollouts: o.budgetRollouts,
      max_iters: o.maxIters,
      plateau_patience: o.plateauPatience ?? null,
      ...(o.reflectModel ? { reflect_model: o.reflectModel } : {}),
      status: "queued",
    })
    .select("id")
    .single();

  if (runErr || !run) {
    await cleanupCreatedConnection();
    if (runErr?.code === "23505") {
      return { error: "An optimization run is already active for this team" };
    }
    await log.error("optimization_runs insert failed", {
      event: "optimization_run.create_failed",
      org_id: orgId,
      error: runErr,
    });
    return { error: "Failed to start optimization run" };
  }

  // Freeze the manually provided instances. On failure, delete the run row so the org isn't
  // left with a stuck active run blocking future starts (and frees the partial-unique slot),
  // and roll back any inline-created Connection.
  const { error: inputsErr } = await supabaseAdmin.from("optimization_inputs").insert(
    o.instances.map((row, i) => ({
      opt_run_id: run.id,
      instance_index: i,
      user_input: row.userInput,
      expected_output: row.expectedOutput ?? null,
      retrieval_context: row.retrievalContext ?? null,
    }))
  );
  if (inputsErr) {
    await log.error("optimization_inputs insert failed", {
      event: "optimization_run.inputs_insert_failed",
      opt_run_id: run.id,
      error: inputsErr,
    });
    await supabaseAdmin.from("optimization_runs").delete().eq("id", run.id);
    await cleanupCreatedConnection();
    return { error: "Failed to save the input set" };
  }

  // Start the durable workflow by string name — workflow code must never enter the Next
  // bundle (it runs only inside the Temporal worker's sandbox).
  const workflowId = `opt-${run.id}`;
  try {
    const client = await getTemporalClient();
    await client.workflow.start("runOptimizationWorkflow", {
      taskQueue: OPTIMIZATION_TASK_QUEUE,
      workflowId,
      args: [{ optRunId: run.id }],
    });
  } catch (err) {
    await log.error("Failed to start optimization workflow", {
      event: "optimization_run.workflow_start_failed",
      opt_run_id: run.id,
      workflow_id: workflowId,
      error: err,
    });
    await supabaseAdmin.from("optimization_runs").delete().eq("id", run.id);
    await cleanupCreatedConnection();
    return { error: "Failed to start optimization run" };
  }

  await supabaseAdmin
    .from("optimization_runs")
    .update({ workflow_id: workflowId })
    .eq("id", run.id);

  await log.info("optimization workflow started", {
    event: "optimization_run.workflow_started",
    opt_run_id: run.id,
    workflow_id: workflowId,
    org_id: orgId,
  });

  await track(
    {
      name: "optimization_run.started",
      props: { instance_count: o.instances.length, budget: o.budgetRollouts },
    },
    { userId }
  );

  revalidatePath("/optimizations");
  return { optRunId: run.id };
}

// ---------- Cancel ----------

// Cancel an active Optimization Run (#109): terminate its Temporal workflow and mark the run
// failed with a "Cancelled by <user>" reason (reusing the terminal `failed` status — no new
// enum). Cancelling frees the org's single active slot immediately, so a misconfigured run no
// longer locks the team out until budget exhaustion or the staleness reaper.
export async function cancelOptimizationRun(
  runId: string
): Promise<{ ok: true } | { error: string }> {
  const { userId, orgId, email, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can cancel optimization runs" };

  // Org-scoped: a caller can only cancel their own team's runs.
  const { data: run } = await supabaseAdmin
    .from("optimization_runs")
    .select("id, status, workflow_id")
    .eq("id", runId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!run) return { error: "Optimization run not found" };
  if (!isActiveOptimizationStatus(run.status as OptimizationRunStatus)) {
    return { error: "This run has already finished" };
  }

  const reason = `Cancelled by ${email ?? "a teammate"}`;

  // Terminate the durable workflow if one was started. terminate() is abrupt — the workflow's
  // own failure path doesn't run — so this action is authoritative for the run row below. The
  // workflow may already be gone (it finished between our read and now); log and proceed so the
  // org's active slot still frees.
  if (run.workflow_id) {
    try {
      const client = await getTemporalClient();
      await client.workflow.getHandle(run.workflow_id as string).terminate(reason);
    } catch (err) {
      await log.error("Failed to terminate optimization workflow", {
        event: "optimization_run.workflow_terminate_failed",
        opt_run_id: runId,
        workflow_id: run.workflow_id,
        error: err,
      });
    }
  }

  // Compare-and-set on the active statuses: if the run reached a terminal state between our
  // read and now (e.g. the workflow's completeRun landed first), the guard makes this a no-op
  // rather than clobbering a legitimately-completed run's result back to failed.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from("optimization_runs")
    .update({ status: "failed", error_message: reason })
    .eq("id", runId)
    .eq("org_id", orgId)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .select("id");
  if (updErr) {
    await log.error("Failed to mark optimization run cancelled", {
      event: "optimization_run.cancel_failed",
      opt_run_id: runId,
      error: updErr,
    });
    return { error: "Failed to cancel the run" };
  }
  if (!updated || updated.length === 0) {
    // No active row transitioned — the run finished first. Don't report a false cancel.
    return { error: "This run has already finished" };
  }

  await track({ name: "optimization_run.cancelled", props: {} }, { userId });
  revalidatePath("/optimizations");
  return { ok: true };
}

// ---------- Read ----------

// Resolve a Supabase nested relation (object or single-element array, depending on the
// join) down to its `name`. Mirrors the helper the Schedules layout uses.
function nestedName(rel: unknown): string {
  if (Array.isArray(rel)) return String((rel[0] as { name?: unknown } | undefined)?.name ?? "—");
  if (rel && typeof rel === "object") return String((rel as { name?: unknown }).name ?? "—");
  return "—";
}

// Resolve a Supabase nested rubric relation (object or single-element array) down to the
// {name, weight} pairs the overall-score formula needs. Steps and other fields are ignored.
function rubricCriteria(rel: unknown): ScoredCriterion[] {
  const rubric = Array.isArray(rel) ? rel[0] : rel;
  const criteria = (rubric as { criteria?: unknown } | undefined)?.criteria;
  if (!Array.isArray(criteria)) return [];
  return criteria.map((c) => ({
    name: String((c as { name?: unknown }).name ?? ""),
    weight: Number((c as { weight?: unknown }).weight ?? 0),
  }));
}

// The seed Candidate's overall score on the Pareto set — the lift baseline. Not persisted
// (only the winner's best_score is), so recompute it from the seed's Pareto rollout_results.
// Returns null when the seed has no Pareto rollouts yet (e.g. a run that never got that far).
async function seedOverallScore(
  seedCandidateId: string,
  criteria: ScoredCriterion[]
): Promise<number | null> {
  if (criteria.length === 0) return null;

  const { data: rollouts } = await supabaseAdmin
    .from("optimization_rollouts")
    .select("id")
    .eq("candidate_id", seedCandidateId)
    .eq("phase", PARETO_PHASE);
  const rolloutIds = (rollouts ?? []).map((r) => r.id as string);
  if (rolloutIds.length === 0) return null;

  const { data: results } = await supabaseAdmin
    .from("rollout_results")
    .select("criterion_name, score")
    .in("rollout_id", rolloutIds);

  return overallScoreFromResults(
    criteria,
    (results ?? []).map((r) => ({
      criterion_name: r.criterion_name as string,
      score: Number(r.score),
    }))
  );
}

// Seed scores for a batch of runs, in three bounded queries (not N+1): all seed Candidates,
// their Pareto rollouts, then those rollouts' results — grouped back per run and scored with
// each run's own rubric weights. Runs without a resolvable seed score are simply absent.
async function seedScoresByRun(
  runs: { id: string; criteria: ScoredCriterion[] }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (runs.length === 0) return out;

  const { data: seeds } = await supabaseAdmin
    .from("optimization_candidates")
    .select("id, opt_run_id")
    .in("opt_run_id", runs.map((r) => r.id))
    .eq("generation", 0);
  const seedRows = (seeds ?? []) as { id: string; opt_run_id: string }[];
  if (seedRows.length === 0) return out;
  const runBySeed = new Map(seedRows.map((s) => [s.id, s.opt_run_id]));

  const { data: rollouts } = await supabaseAdmin
    .from("optimization_rollouts")
    .select("id, candidate_id")
    .in("candidate_id", seedRows.map((s) => s.id))
    .eq("phase", PARETO_PHASE);
  const rolloutRows = (rollouts ?? []) as { id: string; candidate_id: string }[];
  if (rolloutRows.length === 0) return out;
  const runByRollout = new Map<string, string>();
  for (const ro of rolloutRows) {
    const runId = runBySeed.get(ro.candidate_id);
    if (runId) runByRollout.set(ro.id, runId);
  }

  const { data: results } = await supabaseAdmin
    .from("rollout_results")
    .select("rollout_id, criterion_name, score")
    .in("rollout_id", rolloutRows.map((r) => r.id));

  const resultsByRun = new Map<string, CriterionResult[]>();
  for (const res of (results ?? []) as {
    rollout_id: string;
    criterion_name: string;
    score: number;
  }[]) {
    const runId = runByRollout.get(res.rollout_id);
    if (!runId) continue;
    const list = resultsByRun.get(runId) ?? [];
    list.push({ criterion_name: res.criterion_name, score: Number(res.score) });
    resultsByRun.set(runId, list);
  }

  const criteriaByRun = new Map(runs.map((r) => [r.id, r.criteria]));
  for (const [runId, res] of resultsByRun) {
    const criteria = criteriaByRun.get(runId) ?? [];
    // Mirror seedOverallScore (the detail path): no criteria means no baseline, so leave the
    // run absent rather than emitting a 0 that reads as a real "0.00 → best" lift on the row.
    if (criteria.length === 0) continue;
    out.set(runId, overallScoreFromResults(criteria, res));
  }
  return out;
}

// List the active team's Optimization Runs, newest first, for the Optimizations surface.
// A run has no name, so each row carries its agent Connection + Rubric names and status.
export async function listOptimizationRuns(): Promise<OptimizationRunSummary[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  const { data } = await supabaseAdmin
    .from("optimization_runs")
    .select(
      "id, status, best_score, created_at, connections!inner(name), rubrics!inner(name, criteria)"
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  const rows = data ?? [];

  // Only completed runs show a score lift, so only they need a seed-score baseline. Compute
  // those in one bounded batch rather than a query per row.
  const completed = rows
    .filter((r) => r.status === "completed")
    .map((r) => ({ id: r.id as string, criteria: rubricCriteria(r.rubrics) }));
  const seedScores = await seedScoresByRun(completed);

  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as OptimizationRunStatus,
    // numeric(4,3) can arrive as a string from PostgREST; coerce so the row's score math
    // (fmtScore/hasLift) never sees a string.
    best_score: r.best_score == null ? null : Number(r.best_score),
    seed_score: seedScores.get(r.id as string) ?? null,
    created_at: r.created_at as string,
    connection_name: nestedName(r.connections),
    rubric_name: nestedName(r.rubrics),
  }));
}

// Read an Optimization Run's status + result for the active team. Returns null if the run
// isn't found in the caller's org (no cross-team leakage).
export async function getOptimizationRun(id: string) {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  const { data: run } = await supabaseAdmin
    .from("optimization_runs")
    .select("*, connections!inner(name), rubrics!inner(name, criteria)")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!run) return null;

  const { count: instanceCount } = await supabaseAdmin
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", id);

  // Derived progress for the in-progress detail (no persisted progress columns, per #105):
  // Candidates discovered so far, and rollouts spent — both head-counted from child rows. Only
  // computed for an active run, since a terminal run's detail shows its result, not progress.
  // Rollouts hang off candidates (no opt_run_id of their own), so count them through an inner
  // join on the run's candidates rather than fetching candidate ids and re-sending them in an
  // IN list — that avoids PostgREST's 1000-row cap and request-URL length limits entirely.
  let candidateCount = 0;
  let rolloutsSpent = 0;
  if (isActiveOptimizationStatus(run.status as OptimizationRunStatus)) {
    const { count: cCount } = await supabaseAdmin
      .from("optimization_candidates")
      .select("id", { count: "exact", head: true })
      .eq("opt_run_id", id);
    candidateCount = cCount ?? 0;

    const { count: rCount } = await supabaseAdmin
      .from("optimization_rollouts")
      .select("id, optimization_candidates!inner(opt_run_id)", { count: "exact", head: true })
      .eq("optimization_candidates.opt_run_id", id);
    rolloutsSpent = rCount ?? 0;
  }

  // Seed Candidate (generation 0) holds the Connection's seed prompts: the diff's "before"
  // and the lift baseline.
  const { data: seed } = await supabaseAdmin
    .from("optimization_candidates")
    .select("id, prompts")
    .eq("opt_run_id", id)
    .eq("generation", 0)
    .maybeSingle();

  // Winning Candidate (best_candidate_id) holds the diff's "after". Null until a run produces
  // a validated winner (i.e. not for queued/running/most failed runs).
  let winningPrompts: Record<string, string> | null = null;
  if (run.best_candidate_id) {
    const { data: winner } = await supabaseAdmin
      .from("optimization_candidates")
      .select("prompts")
      .eq("id", run.best_candidate_id as string)
      .maybeSingle();
    winningPrompts = (winner?.prompts as Record<string, string> | undefined) ?? null;
  }

  const seedScore = seed
    ? await seedOverallScore(seed.id as string, rubricCriteria(run.rubrics))
    : null;

  return {
    run,
    instanceCount: instanceCount ?? 0,
    candidateCount,
    rolloutsSpent,
    seedPrompts: (seed?.prompts as Record<string, string> | undefined) ?? null,
    winningPrompts,
    seedScore,
  };
}
