"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";


// ---------- Schemas ----------

const CriterionSchema = z.object({
  name: z.string().min(1, "Criterion name is required"),
  weight: z.number().min(0).max(1),
  steps: z
    .array(z.string().min(1, "Step cannot be empty"))
    .min(1, "At least one step is required"),
});

const RubricSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  scenario_description: z.string().min(1, "Scenario description is required"),
  expected_outcome: z.string().min(1, "Expected outcome is required"),
  evaluation_mode: z.enum(["conversational", "prompt_response"]),
  grounding_context: z.string().nullable().optional(),
  criteria: z
    .array(CriterionSchema)
    .min(1, "At least one criterion is required")
    .refine(
      (criteria) => {
        const total = criteria.reduce((sum, c) => sum + c.weight, 0);
        return Math.abs(total - 1.0) < 0.001;
      },
      { message: "Criterion weights must sum to 1.0" }
    ),
});

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
