"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import {
  NewConnectionSchema,
  UpdateConnectionModulesSchema,
  UpdateManagedConnectionSchema,
} from "@/lib/validation/schemas";
import { insertConnection, MANAGED_MODULE_NAME } from "@/lib/connections/create";
import { log } from "@/lib/logging/server";
import { track } from "@/lib/analytics/server";
import { ACTIVE_OPTIMIZATION_STATUSES } from "@/types/optimization";

// ---------- Read ----------

export async function listConnections() {
  const ctx = await getAuthContext();
  if (!ctx.userId || !ctx.orgId) return [];

  const { data } = await tenantDb(ctx)
    .from("connections")
    .select("id", "name", "kind", "provider", "endpoint", "response_path", "created_at")
    .order("created_at", { ascending: false });

  return data ?? [];
}

// ---------- Create ----------

export async function createConnection(
  input: z.input<typeof NewConnectionSchema>
): Promise<{ connectionId: string; warning?: string } | { error: string }> {
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
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can edit connections" };

  const parsed = UpdateConnectionModulesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid Modules" };
  }
  const { connectionId, requestTemplate, modules } = parsed.data;

  // The connection must belong to the team, and only the agent kind has Modules.
  const { data: conn } = await tenantDb(ctx)
    .from("connections")
    .select("id", "kind")
    .eq("id", connectionId)
    .maybeSingle();
  if (!conn) return { error: "Connection not found" };
  if (conn.kind !== "agent") return { error: "Only agent connections have Modules" };

  // The GEPA worker re-loads the connection on every rollout but the workflow captures the
  // Module NAMES once at seed time, and candidate prompt maps are keyed by those names.
  // Renaming or removing a Module while a run is in flight would make every candidate
  // silently render from the seeds (overrides keyed to names that no longer exist), so the
  // run completes with meaningless scores. Block edits while a run is active instead.
  const { data: activeRun } = await supabaseAdmin
    .from("optimization_runs")
    .select("id")
    .eq("connection_id", conn.id)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .limit(1)
    .maybeSingle();
  if (activeRun) {
    return {
      error:
        "An optimization run is currently using this connection — wait for it to finish before editing Modules.",
    };
  }

  const { error } = await tenantDb(ctx)
    .from("connections")
    .update({
      // Schema already guarantees valid JSON; stored as jsonb like insertConnection does.
      request_template: JSON.parse(requestTemplate),
      optimizable_prompts: modules.length ? modules : null,
    })
    .eq("id", conn.id);
  if (error) {
    await log.error("connections update failed", {
      event: "connection.update_failed",
      connection_id: conn.id,
      error,
    });
    return { error: "Failed to update connection" };
  }

  revalidatePath("/settings/connections");
  // The optimization wizard's existing-connection list keys off optimizable_prompts.
  revalidatePath("/optimizations");
  return { ok: true };
}

// Edit a Managed Agent ("Paste a prompt") Connection (#294): just its prompt and target model.
// A managed Connection has no request template, so the template-coupled updateConnectionModules
// (and its declared↔referenced cross-check) doesn't apply — that path would reject the single
// "prompt" Module as unreferenced. We rewrite the one Module's seed and the target model, leaving
// request_template null.
export async function updateManagedConnection(
  input: z.input<typeof UpdateManagedConnectionSchema>
): Promise<{ ok: true } | { error: string }> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can edit connections" };

  const parsed = UpdateManagedConnectionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid prompt" };
  }
  const { connectionId, prompt, targetModel } = parsed.data;

  // Must belong to the team and actually be a managed agent — never reshape an external agent or
  // dataset through this path.
  const { data: conn } = await tenantDb(ctx)
    .from("connections")
    .select("id", "agent_kind")
    .eq("id", connectionId)
    .maybeSingle();
  if (!conn) return { error: "Connection not found" };
  if (conn.agent_kind !== "managed") return { error: "Not a Managed Agent connection" };

  // Same active-run guard as updateConnectionModules: the GEPA worker captures the Module name and
  // seed at run start, so editing the prompt mid-run would silently change what's being optimized.
  const { data: activeRun } = await supabaseAdmin
    .from("optimization_runs")
    .select("id")
    .eq("connection_id", conn.id)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .limit(1)
    .maybeSingle();
  if (activeRun) {
    return {
      error:
        "An optimization run is currently using this connection — wait for it to finish before editing the prompt.",
    };
  }

  const { error } = await tenantDb(ctx)
    .from("connections")
    .update({
      // The single Module's seed IS the prompt (name is the internal MANAGED_MODULE_NAME).
      optimizable_prompts: [{ name: MANAGED_MODULE_NAME, seed: prompt.trim() }],
      target_model: targetModel,
    })
    .eq("id", conn.id);
  if (error) {
    await log.error("managed connection update failed", {
      event: "connection.update_failed",
      connection_id: conn.id,
      error,
    });
    return { error: "Failed to update connection" };
  }

  revalidatePath("/settings/connections");
  revalidatePath("/optimizations");
  return { ok: true };
}

// ---------- Delete ----------

// What deleting a Connection would take with it. Both schedules.connection_id and
// optimization_runs.connection_id are ON DELETE CASCADE, so a delete silently removes every
// schedule (and its inputs) and the full optimization history that reference this connection.
// We surface those counts in the confirm dialog, and refuse the delete outright while work is
// live — an active (queued/running) run or an enabled schedule — so nothing is yanked out from
// under the worker mid-flight. (#225)
export interface ConnectionDeletionImpact {
  name: string;
  schedules: number;
  optimizationRuns: number;
  // Non-null => the delete is blocked; the string explains why and how to unblock it. When
  // null, every counted schedule is disabled and every counted run is terminal, so the counts
  // above are exactly what cascades away.
  blockReason: string | null;
}

// Shared guard for both the impact preview and the delete itself — the client warning is
// advisory, so deleteConnection re-runs this server-side before touching anything.
async function connectionDeleteBlocker(connectionId: string): Promise<string | null> {
  const { count: activeRuns } = await supabaseAdmin
    .from("optimization_runs")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES);
  if (activeRuns && activeRuns > 0) {
    return "An optimization run is currently using this connection — wait for it to finish before deleting.";
  }

  const { count: enabledSchedules } = await supabaseAdmin
    .from("schedules")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId)
    .eq("enabled", true);
  if (enabledSchedules && enabledSchedules > 0) {
    return "This connection is used by an active schedule — disable or delete the schedule first.";
  }

  return null;
}

export async function getConnectionDeletionImpact(
  connectionId: string
): Promise<ConnectionDeletionImpact | { error: string }> {
  const ctx = await getAuthContext();
  const { userId, orgId } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };

  const { data: conn } = await tenantDb(ctx)
    .from("connections")
    .select("id", "name")
    .eq("id", connectionId)
    .maybeSingle();
  if (!conn) return { error: "Connection not found" };

  const [{ count: schedules }, { count: optimizationRuns }, blockReason] = await Promise.all([
    supabaseAdmin
      .from("schedules")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", conn.id),
    supabaseAdmin
      .from("optimization_runs")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", conn.id),
    connectionDeleteBlocker(conn.id),
  ]);

  return {
    name: conn.name,
    schedules: schedules ?? 0,
    optimizationRuns: optimizationRuns ?? 0,
    blockReason,
  };
}

export async function deleteConnection(
  connectionId: string
): Promise<{ ok: true } | { error: string }> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can delete connections" };

  // Org-scope the lookup: a wrong/foreign id resolves to no row and falls through to this error.
  const { data: conn } = await tenantDb(ctx)
    .from("connections")
    .select("id")
    .eq("id", connectionId)
    .maybeSingle();
  if (!conn) return { error: "Connection not found" };

  const blocker = await connectionDeleteBlocker(conn.id);
  if (blocker) return { error: blocker };

  // Cascading the connection nulls optimization_run_ledger.opt_run_id (ON DELETE SET NULL),
  // so a still-open reservation would become unfindable and pin a unit for the rest of the
  // period (mirrors deleteRubric, #181). The blocker above rules out active runs, so every
  // referenced run is terminal; settle each before the delete. settle_optimization_run is
  // idempotent and a no-op for unmetered/already-settled runs. (eval_runs don't reference
  // connections — they survive a schedule cascade via schedule_id set-null — so there's no
  // Eval Points exposure here.)
  const { data: runs } = await supabaseAdmin
    .from("optimization_runs")
    .select("id")
    .eq("connection_id", conn.id);
  for (const run of runs ?? []) {
    const { error: settleError } = await supabaseAdmin.rpc("settle_optimization_run", {
      p_run_id: run.id,
    });
    if (settleError) {
      await log.error("allowance release failed during connection delete — unit may be stranded", {
        event: "optimization_run.allowance_release_failed",
        opt_run_id: run.id,
        org_id: orgId,
        error: settleError,
      });
    }
  }

  const { error } = await tenantDb(ctx).from("connections").delete().eq("id", conn.id);
  if (error) {
    await log.error("connections delete failed", {
      event: "connection.delete_failed",
      connection_id: conn.id,
      error,
    });
    return { error: "Failed to delete connection" };
  }

  await track({ name: "connection.deleted", props: { connection_id: conn.id } }, { userId });
  // Disabled schedules + terminal optimization runs cascade away; refresh every surface that
  // lists them. The vault secret is cleaned by the connection_secret_cleanup DELETE trigger.
  revalidatePath("/settings/connections");
  revalidatePath("/optimizations");
  revalidatePath("/schedules");
  return { ok: true };
}
