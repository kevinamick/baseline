"use server";

import { getAuthContext } from "@/lib/auth/context";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { RubricSchema } from "@/lib/validation/schemas";


// ---------- Action state ----------

export type RubricActionState = {
  errors?: Partial<Record<string, string[]>>;
  message?: string;
  success?: boolean;
};

// ---------- Read ----------

export async function getRubric(id: string) {
  const ctx = await getAuthContext();
  if (!ctx.userId || !ctx.orgId) return null;

  // org filter is applied by the helper; only the row id is left to chain.
  const { data } = await tenantDb(ctx)
    .from("rubrics")
    .select()
    .eq("id", id)
    .maybeSingle();

  return data;
}

// ---------- Create ----------

export async function createRubric(
  _prevState: RubricActionState,
  formData: FormData
): Promise<RubricActionState> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (!canWrite) throw new Error("Only contributors can create rubrics");

  let criteriaRaw: unknown;
  try {
    criteriaRaw = JSON.parse(formData.get("criteria") as string);
  } catch {
    return { errors: { criteria: ["Invalid criteria format"] } };
  }

  const parsed = RubricSchema.safeParse({
    name: formData.get("name"),
    scenario_description: formData.get("scenario_description"),
    expected_outcome: formData.get("expected_outcome"),
    evaluation_mode: formData.get("evaluation_mode"),
    grounding_context: formData.get("grounding_context") || null,
    criteria: criteriaRaw,
  });

  if (!parsed.success) {
    return {
      errors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      message: "Please fix the errors below.",
    };
  }

  const { data } = parsed;

  // insert() stamps org_id from ctx — no need to pass it (and a caller-supplied
  // one would be stripped), so the row can't land under another org.
  const { data: rubric, error } = await tenantDb(ctx)
    .from("rubrics")
    .insert({
      created_by: userId,
      name: data.name,
      scenario_description: data.scenario_description,
      expected_outcome: data.expected_outcome,
      evaluation_mode: data.evaluation_mode,
      grounding_context: data.grounding_context ?? null,
      criteria: data.criteria,
    })
    .select("id")
    .single();

  if (error || !rubric) {
    await log.error("rubrics insert failed", {
      event: "rubric.create_failed",
      org_id: orgId,
      error,
    });
    return { message: "Failed to save rubric. Please try again." };
  }

  await track(
    {
      name: "rubric.created",
      props: {
        evaluation_mode: data.evaluation_mode,
        criteria_count: data.criteria.length,
      },
    },
    { userId }
  );

  revalidatePath("/rubrics");
  return { success: true };
}

// ---------- Delete ----------

export async function deleteRubric(id: string): Promise<void> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (!canWrite) throw new Error("Only contributors can delete rubrics");

  // Deleting a rubric cascade-deletes its eval_runs AND optimization_runs,
  // which nulls both ledgers' run FKs — a still-open reservation would become
  // unfindable and pin its points/unit for the rest of the period (#180/#181).
  // Release in-flight runs on both meters first; the settles are idempotent
  // and no-ops for runs without a reservation.
  const { data: inFlight } = await supabaseAdmin
    .from("eval_runs")
    .select("id")
    .eq("rubric_id", id)
    .in("status", ["queued", "running"]);
  for (const run of inFlight ?? []) {
    const { error: settleError } = await supabaseAdmin.rpc("settle_eval_run_points", {
      p_run_id: run.id,
      p_outcome: "skipped",
    });
    if (settleError) {
      await log.error("reservation release failed during rubric delete — points may be stranded", {
        event: "eval_run.reservation_release_failed",
        run_id: run.id,
        org_id: orgId,
        error: settleError,
      });
    }
  }
  const { data: inFlightOpt } = await supabaseAdmin
    .from("optimization_runs")
    .select("id")
    .eq("rubric_id", id)
    .in("status", ["queued", "running"]);
  for (const run of inFlightOpt ?? []) {
    const { error: settleError } = await supabaseAdmin.rpc("settle_optimization_run", {
      p_run_id: run.id,
    });
    if (settleError) {
      await log.error("allowance release failed during rubric delete — unit may be stranded", {
        event: "optimization_run.allowance_release_failed",
        opt_run_id: run.id,
        org_id: orgId,
        error: settleError,
      });
    }
  }

  // delete() is pre-constrained to ctx.orgId; only the row id is left to chain.
  const { error } = await tenantDb(ctx).from("rubrics").delete().eq("id", id);

  if (error) {
    await log.error("rubrics delete failed", {
      event: "rubric.delete_failed",
      rubric_id: id,
      error,
    });
    throw new Error("Failed to delete rubric.");
  }

  await track({ name: "rubric.deleted", props: { rubric_id: id } }, { userId });

  revalidatePath("/rubrics");
  redirect("/rubrics");
}

// ---------- Update ----------

export async function updateRubric(
  _prevState: RubricActionState,
  formData: FormData
): Promise<RubricActionState> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (!canWrite) throw new Error("Only contributors can update rubrics");

  const id = formData.get("id") as string;
  if (!id) return { message: "Missing rubric ID." };

  let criteriaRaw: unknown;
  try {
    criteriaRaw = JSON.parse(formData.get("criteria") as string);
  } catch {
    return { errors: { criteria: ["Invalid criteria format"] } };
  }

  const parsed = RubricSchema.safeParse({
    name: formData.get("name"),
    scenario_description: formData.get("scenario_description"),
    expected_outcome: formData.get("expected_outcome"),
    evaluation_mode: formData.get("evaluation_mode"),
    grounding_context: formData.get("grounding_context") || null,
    criteria: criteriaRaw,
  });

  if (!parsed.success) {
    return {
      errors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      message: "Please fix the errors below.",
    };
  }

  const { data } = parsed;

  // update() is pre-constrained to ctx.orgId; only the row id is left to chain.
  const { error } = await tenantDb(ctx)
    .from("rubrics")
    .update({
      name: data.name,
      scenario_description: data.scenario_description,
      expected_outcome: data.expected_outcome,
      evaluation_mode: data.evaluation_mode,
      grounding_context: data.grounding_context ?? null,
      criteria: data.criteria,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    await log.error("rubrics update failed", {
      event: "rubric.update_failed",
      rubric_id: id,
      error,
    });
    return { message: "Failed to update rubric. Please try again." };
  }

  await track(
    {
      name: "rubric.updated",
      props: {
        rubric_id: id,
        evaluation_mode: data.evaluation_mode,
        criteria_count: data.criteria.length,
      },
    },
    { userId }
  );

  revalidatePath("/rubrics");
  return { success: true };
}
