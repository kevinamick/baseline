"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { getTemporalClient } from "@/lib/temporal/client";
import { OPTIMIZATION_TASK_QUEUE } from "@/lib/temporal/connection";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";

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

  // Verify the connection belongs to the team and is an agent — only agents expose the
  // {{prompt:*}} Modules an optimization run tunes.
  const { data: connection } = await supabaseAdmin
    .from("connections")
    .select("id, kind")
    .eq("id", o.connectionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!connection) return { error: "Connection not found" };
  if (connection.kind !== "agent") {
    return { error: "Optimization requires an agent connection" };
  }

  // Insert the run as queued. The partial unique index (one active run per org) rejects a
  // concurrent second start with a 23505 — surface that as a friendly message.
  const { data: run, error: runErr } = await supabaseAdmin
    .from("optimization_runs")
    .insert({
      org_id: orgId,
      created_by: userId,
      connection_id: o.connectionId,
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
    if (runErr?.code === "23505") {
      return { error: "An optimization run is already active for this team" };
    }
    console.error("optimization_runs insert failed", runErr);
    return { error: "Failed to start optimization run" };
  }

  // Freeze the manually provided instances. On failure, delete the run row so the org isn't
  // left with a stuck active run blocking future starts (and frees the partial-unique slot).
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
    console.error("optimization_inputs insert failed", inputsErr);
    await supabaseAdmin.from("optimization_runs").delete().eq("id", run.id);
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
    console.error("Failed to start optimization workflow", err);
    await supabaseAdmin.from("optimization_runs").delete().eq("id", run.id);
    return { error: "Failed to start optimization run" };
  }

  await supabaseAdmin
    .from("optimization_runs")
    .update({ workflow_id: workflowId })
    .eq("id", run.id);

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

// ---------- Read ----------

// Read an Optimization Run's status + result for the active team. Returns null if the run
// isn't found in the caller's org (no cross-team leakage).
export async function getOptimizationRun(id: string) {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  const { data: run } = await supabaseAdmin
    .from("optimization_runs")
    .select("*, connections!inner(name), rubrics!inner(name)")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!run) return null;

  const { count: instanceCount } = await supabaseAdmin
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", id);

  return { run, instanceCount: instanceCount ?? 0 };
}
