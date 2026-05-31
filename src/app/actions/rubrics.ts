"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { RubricSchema } from "@/lib/validation/schemas";


// ---------- Action state ----------

export type RubricActionState = {
  errors?: Partial<Record<string, string[]>>;
  message?: string;
  success?: boolean;
};

// ---------- Read ----------

export async function getRubric(id: string) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return null;

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();

  return data;
}

// ---------- Create ----------

export async function createRubric(
  _prevState: RubricActionState,
  formData: FormData
): Promise<RubricActionState> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (orgRole !== "org:admin") throw new Error("Only contributors can create rubrics");

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

  const { data: rubric, error } = await supabaseAdmin
    .from("rubrics")
    .insert({
      created_by: userId,
      org_id: orgId,
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
    console.error("rubrics insert failed", error);
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
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (orgRole !== "org:admin") throw new Error("Only contributors can delete rubrics");

  const { error } = await supabaseAdmin
    .from("rubrics")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);

  if (error) {
    console.error("rubrics delete failed", error);
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
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (orgRole !== "org:admin") throw new Error("Only contributors can update rubrics");

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

  const { error } = await supabaseAdmin
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
    .eq("id", id)
    .eq("org_id", orgId);

  if (error) {
    console.error("rubrics update failed", error);
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
