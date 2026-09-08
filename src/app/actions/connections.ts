"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext, type AuthContext } from "@/lib/auth/context";
import { requireContributor } from "@/lib/auth/require-contributor";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import {
  DatasetPreviewSchema,
  NewConnectionSchema,
  UpdateConnectionModulesSchema,
  UpdateManagedConnectionSchema,
} from "@/lib/validation/schemas";
import { firstIssueMessage } from "@/lib/validation/first-issue";
import {
  insertConnection,
  MANAGED_MODULE_NAME,
} from "@/lib/connections/create";
import { runDatasetPreview } from "@/lib/connections/preview";
import type { PreviewResult } from "@/lib/connections/preview-types";
import { log } from "@/lib/logging/server";
import { track } from "@/lib/analytics/server";
import { ACTIVE_OPTIMIZATION_STATUSES } from "@/types/optimization";

// ---------- Read ----------

export async function listConnections() {
  const ctx = await getAuthContext();
  if (!ctx.userId || !ctx.orgId) return [];

  const { data, error } = await tenantDb(ctx)
    .from("connections")
    .select(
      "id",
      "name",
      "kind",
      "provider",
      "endpoint",
      "response_path",
      "created_at",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;

  return data ?? [];
}

// ---------- Create ----------

export async function createConnection(
  input: z.input<typeof NewConnectionSchema>,
): Promise<{ connectionId: string; warning?: string } | { error: string }> {
  const gate = await requireContributor("create connections");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;

  const parsed = NewConnectionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Invalid connection") };
  }

  const result = await insertConnection(orgId, userId, parsed.data);
  if (!("error" in result)) {
    await track(
      {
        name: "connection.created",
        props: { connection_id: result.connectionId, type: parsed.data.type },
      },
      { userId },
    );
    // Without this the action response carries no rerendered page, and the
    // connections list only updates if the client's follow-up router.refresh()
    // survives — which it can fail to do under load. Same three surfaces as
    // deleteConnection: the settings list plus both wizards' connection pickers.
    revalidatePath("/settings/connections");
    revalidatePath("/optimizations");
    revalidatePath("/schedules");
  }
  return result;
}

// ---------- Preview ----------

// "Test query" for a dataset Connection being configured in the schedule wizard (#39). Runs the
// worker's dataset adapter once against a bounded window/row cap with a timeout and returns the
// sample rows mapped to user_input/agent_output/expected_output/retrieval_context, so the user
// can verify their HogQL aliases / field-map paths / auth before saving.
//
// A contributor gate (canWrite) is the authority here: a preview dereferences a tenant-supplied
// URL with a tenant-supplied credential, so it's only for someone who could create the schedule
// anyway. The SSRF egress guard + PostHog host allowlist are enforced inside the adapter
// (safeFetch), not here. The typed credential is used transiently and never persisted.
export async function previewDatasetConnection(
  input: z.input<typeof DatasetPreviewSchema>
): Promise<PreviewResult> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "forbidden" };
  if (!canWrite) return { error: "forbidden" };

  const parsed = DatasetPreviewSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "config", detail: parsed.error.issues[0]?.message };
  }

  const result = await runDatasetPreview(parsed.data);

  // Make the "Test query" outcome queryable in PostHog Logs (request_id/org_id/user_id
  // auto-correlate via the request scope). A failure is logged with its categorized code +
  // the adapter's raw diagnostic so operators can see why previews fail without a repro; an
  // "endpoint" failure escalates to error because it is the SSRF/egress-refusal signal — a
  // tenant-supplied URL the egress guard blocked (the surface that produced the confirmed SSRF
  // incident), worth surfacing distinctly from ordinary user misconfiguration.
  if ("error" in result) {
    const failure = {
      event: "connection.preview_failed",
      provider: parsed.data.type,
      error_code: result.error,
      detail: result.detail,
    };
    if (result.error === "endpoint") {
      await log.error("dataset preview blocked or unreachable", failure);
    } else {
      await log.warn("dataset preview failed", failure);
    }
  } else if (result.warning === "no_columns_mapped") {
    await log.info("dataset preview returned unmapped rows", {
      event: "connection.preview_unmapped",
      provider: parsed.data.type,
      row_count: result.rows.length,
    });
  }

  return result;
}

// ---------- Update ----------

// Edit an existing agent Connection's Modules + request template (#119). The schema enforces
// the declared↔referenced cross-check (every Module referenced as {{prompt:name}} and
// vice-versa), so a Connection can't be saved into a state the worker would reject at run
// time. Setting an empty Module list (with a ref-free template) stores null — back to the
// plain {{user_input}}-only agent.
export async function updateConnectionModules(
  input: z.input<typeof UpdateConnectionModulesSchema>,
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("edit connections");
  if ("error" in gate) return gate;
  const { ctx } = gate;

  const parsed = UpdateConnectionModulesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Invalid Modules") };
  }
  const { connectionId, requestTemplate, modules } = parsed.data;

  // The connection must belong to the team, and only the agent kind has Modules.
  const { data: conn, error: connErr } = await tenantDb(ctx)
    .from("connections")
    .select("id", "kind")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn) return { error: "Connection not found" };
  if (conn.kind !== "agent")
    return { error: "Only agent connections have Modules" };

  // The GEPA worker re-loads the connection on every rollout but the workflow captures the
  // Module NAMES once at seed time, and candidate prompt maps are keyed by those names.
  // Renaming or removing a Module while a run is in flight would make every candidate
  // silently render from the seeds (overrides keyed to names that no longer exist), so the
  // run completes with meaningless scores. Block edits while a run is active instead.
  const { data: activeRun, error: activeRunErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id")
    .eq("connection_id", conn.id)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .limit(1)
    .maybeSingle();
  if (activeRunErr) {
    return {
      error: "Couldn't check for active optimization runs. Please try again.",
    };
  }
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
  input: z.input<typeof UpdateManagedConnectionSchema>,
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("edit connections");
  if ("error" in gate) return gate;
  const { ctx } = gate;

  const parsed = UpdateManagedConnectionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Invalid prompt") };
  }
  const { connectionId, prompt, targetModel } = parsed.data;

  // Must belong to the team and actually be a managed agent — never reshape an external agent or
  // dataset through this path.
  const { data: conn, error: connErr } = await tenantDb(ctx)
    .from("connections")
    .select("id", "agent_kind")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn) return { error: "Connection not found" };
  if (conn.agent_kind !== "managed")
    return { error: "Not a Managed Agent connection" };

  // Same active-run guard as updateConnectionModules: the GEPA worker captures the Module name and
  // seed at run start, so editing the prompt mid-run would silently change what's being optimized.
  const { data: activeRun, error: activeRunErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id")
    .eq("connection_id", conn.id)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .limit(1)
    .maybeSingle();
  if (activeRunErr) {
    return {
      error: "Couldn't check for active optimization runs. Please try again.",
    };
  }
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
async function connectionDeleteBlocker(
  ctx: AuthContext,
  connectionId: string,
): Promise<string | null> {
  const { count: activeRuns, error: runsErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .count("id")
    .eq("connection_id", connectionId)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES);
  if (runsErr) throw runsErr;
  if (activeRuns && activeRuns > 0) {
    return "An optimization run is currently using this connection — wait for it to finish before deleting.";
  }

  const { count: enabledSchedules, error: schedulesErr } = await tenantDb(ctx)
    .from("schedules")
    .count("id")
    .eq("connection_id", connectionId)
    .eq("enabled", true);
  if (schedulesErr) throw schedulesErr;
  if (enabledSchedules && enabledSchedules > 0) {
    return "This connection is used by an active schedule — disable or delete the schedule first.";
  }

  return null;
}

export async function getConnectionDeletionImpact(
  connectionId: string,
): Promise<ConnectionDeletionImpact | { error: string }> {
  const ctx = await getAuthContext();
  const { userId, orgId } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };

  const { data: conn, error: connErr } = await tenantDb(ctx)
    .from("connections")
    .select("id", "name")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn) return { error: "Connection not found" };

  const [schedulesResult, runsResult, blockReason] = await Promise.all([
    tenantDb(ctx).from("schedules").count("id").eq("connection_id", conn.id),
    tenantDb(ctx).from("optimization_runs").count("id").eq("connection_id", conn.id),
    connectionDeleteBlocker(ctx, conn.id),
  ]);
  if (schedulesResult.error) throw schedulesResult.error;
  if (runsResult.error) throw runsResult.error;

  return {
    name: conn.name,
    schedules: schedulesResult.count ?? 0,
    optimizationRuns: runsResult.count ?? 0,
    blockReason,
  };
}

export async function deleteConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("delete connections");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;

  // Org-scope the lookup: a wrong/foreign id resolves to no row and falls through to this error.
  const { data: conn, error: connErr } = await tenantDb(ctx)
    .from("connections")
    .select("id")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn) return { error: "Connection not found" };

  let blocker: string | null;
  try {
    blocker = await connectionDeleteBlocker(ctx, conn.id);
  } catch (blockerErr) {
    await log.error("connection delete blocker check failed", {
      event: "connection.delete_blocker_failed",
      connection_id: conn.id,
      error: blockerErr,
    });
    return {
      error:
        "Couldn't check whether this connection is safe to delete. Please try again.",
    };
  }
  if (blocker) return { error: blocker };

  // Cascading the connection nulls optimization_run_ledger.opt_run_id (ON DELETE SET NULL),
  // so a still-open reservation would become unfindable and pin a unit for the rest of the
  // period (mirrors deleteRubric, #181). The blocker above rules out active runs, so every
  // referenced run is terminal; settle each before the delete. settle_optimization_run is
  // idempotent and a no-op for unmetered/already-settled runs. (eval_runs don't reference
  // connections — they survive a schedule cascade via schedule_id set-null — so there's no
  // Eval Points exposure here.)
  const { data: runs, error: runsListErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id")
    .eq("connection_id", conn.id);
  if (runsListErr) {
    await log.error(
      "failed to list runs for settlement during connection delete",
      {
        event: "connection.delete_settlement_list_failed",
        connection_id: conn.id,
        error: runsListErr,
      },
    );
    return {
      error:
        "Couldn't verify outstanding runs before deleting. Please try again.",
    };
  }
  // Settles are idempotent and mutually independent; release every referenced run
  // concurrently instead of one await per run.
  await Promise.all(
    (runs ?? []).map(async (run) => {
      const { error: settleError } = await supabaseAdmin.rpc(
        "settle_optimization_run",
        {
          p_run_id: run.id,
        },
      );
      if (settleError) {
        await log.error(
          "allowance release failed during connection delete — unit may be stranded",
          {
            event: "optimization_run.allowance_release_failed",
            opt_run_id: run.id,
            org_id: orgId,
            error: settleError,
          },
        );
      }
    }),
  );

  // `.select("id")` turns the delete into `return=representation`, so we get back exactly the
  // rows PostgREST matched. A DELETE...WHERE that matches zero rows is NOT a Postgrest error —
  // it resolves with `error: null` and an empty array — so without this check a mis-scoped or
  // already-gone id would silently report success while leaving the row (and its Vault secret,
  // #225) untouched. The row was confirmed to exist under this exact org scope moments ago
  // (the lookup above), so a zero-row result here means it was removed by a concurrent request
  // in between (e.g. a double-submit or a second tab) — genuinely not-found by the time this
  // delete ran, not a silent failure to act on a live row.
  const { data: deleted, error } = await tenantDb(ctx)
    .from("connections")
    .delete()
    .eq("id", conn.id)
    .select("id");
  if (error) {
    await log.error("connections delete failed", {
      event: "connection.delete_failed",
      connection_id: conn.id,
      error,
    });
    return { error: "Failed to delete connection" };
  }
  if (!deleted || deleted.length === 0) {
    await log.error(
      "connection delete matched no rows — already deleted or org-scope mismatch",
      {
        event: "connection.delete_no_match",
        connection_id: conn.id,
        org_id: orgId,
      },
    );
    return { error: "Connection not found" };
  }

  await track(
    { name: "connection.deleted", props: { connection_id: conn.id } },
    { userId },
  );
  // Disabled schedules + terminal optimization runs cascade away; refresh every surface that
  // lists them. The vault secret is cleaned by the connection_secret_cleanup DELETE trigger.
  revalidatePath("/settings/connections");
  revalidatePath("/optimizations");
  revalidatePath("/schedules");
  return { ok: true };
}
