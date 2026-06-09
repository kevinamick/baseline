"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NewConnectionSchema, UpdateConnectionModulesSchema } from "@/lib/validation/schemas";
import { insertConnection } from "@/lib/connections/create";

// ---------- Read ----------

export async function listConnections() {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  const { data } = await supabaseAdmin
    .from("connections")
    .select("id, name, kind, provider, endpoint, response_path, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  return data ?? [];
}

// ---------- Create ----------

export async function createConnection(
  input: z.input<typeof NewConnectionSchema>
): Promise<{ connectionId: string } | { error: string }> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can create connections" };

  const parsed = NewConnectionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid connection" };
  }

  return insertConnection(orgId, userId, parsed.data);
}

// ---------- Update ----------

// Edit an existing agent Connection's Modules + request template (#119). The schema enforces
// the declared↔referenced cross-check (every Module referenced as {{prompt:name}} and
// vice-versa), so a Connection can't be saved into a state the worker would reject at run
// time. Setting an empty Module list (with a ref-free template) stores null — back to the
// plain {{user_input}}-only agent.
export async function updateConnectionModules(
  input: z.input<typeof UpdateConnectionModulesSchema>
): Promise<{ ok: true } | { error: string }> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can edit connections" };

  const parsed = UpdateConnectionModulesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid Modules" };
  }
  const { connectionId, requestTemplate, modules } = parsed.data;

  // The connection must belong to the team, and only the agent kind has Modules.
  const { data: conn } = await supabaseAdmin
    .from("connections")
    .select("id, kind")
    .eq("id", connectionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!conn) return { error: "Connection not found" };
  if (conn.kind !== "agent") return { error: "Only agent connections have Modules" };

  const { error } = await supabaseAdmin
    .from("connections")
    .update({
      // Schema already guarantees valid JSON; stored as jsonb like insertConnection does.
      request_template: JSON.parse(requestTemplate),
      optimizable_prompts: modules.length ? modules : null,
    })
    .eq("id", conn.id);
  if (error) {
    console.error("connections update failed", error);
    return { error: "Failed to update connection" };
  }

  revalidatePath("/settings/connections");
  // The optimization wizard's existing-connection list keys off optimizable_prompts.
  revalidatePath("/optimizations");
  return { ok: true };
}
