"use server";

import { getAuthContext } from "@/lib/auth/context";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NewConnectionSchema } from "@/lib/validation/schemas";
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
