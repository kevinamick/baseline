"use server";

import { getAuthContext } from "@/lib/auth/context";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { CreateScheduleSchema, isDatasetConnectionType } from "@/lib/validation/schemas";
import { insertConnection } from "@/lib/connections/create";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";

// Managed Agent paid gate (#292). A Managed Agent runs on Baseline's managed key — a paid-plan
// feature — so a Free/unpaid Team can neither select nor inline-create one (managedMarkupPct ==
// null ⇔ Free). Returns the upgrade reason when the Team is gated, or null when allowed.
async function managedGateError(orgId: string): Promise<string | null> {
  const { plan } = await getBillingState(orgId);
  if (PLANS[plan].managedMarkupPct != null) return null;
  return "Managed Agents are a paid-plan feature — they run on Baseline's managed key. Upgrade under Settings → Billing, or choose an agent that uses your own endpoint or provider key.";
}

// ---------- Create ----------

export async function createSchedule(
  input: z.input<typeof CreateScheduleSchema>
): Promise<{ scheduleId: string } | { error: string }> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can create schedules" };

  const parsed = CreateScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid schedule" };
  }
  const s = parsed.data;

  // Verify the rubric belongs to the team.
  const { data: rubric, error: rubricErr } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", s.rubricId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (rubricErr) throw rubricErr;
  if (!rubric) return { error: "Rubric not found" };

  // Resolve the System connection: an existing one (verify ownership) or create inline.
  // We also need its kind: agent schedules carry a fixed input set; dataset schedules
  // carry a sampling window instead. For an existing connection the schema can't see the
  // kind, so we resolve it here and enforce the kind-specific requirements server-side.
  // A Managed Agent (#294) is selected (an existing managed Connection) or created inline from the
  // wizard's "Paste a prompt" mode. Either way it's an agent kind that runs on the managed LLM, so
  // it carries a fixed input set (not a dataset sampling window) and is subject to the paid gate.
  // The gate (#292) runs BEFORE any inline Connection is created, so a Free Team can't even
  // transiently materialize a managed row; the worker's resolve-key → none is the fail-closed
  // backstop, and #294 also disables the managed option in the picker, but this is the authority.
  let connectionId: string;
  let connectionKind: string;
  let connectionIsManaged = false;
  let createdConnectionId: string | null = null;
  if (s.connectionId) {
    const { data: conn, error: connErr } = await tenantDb(ctx)
      .from("connections")
      .select("id", "kind", "agent_kind")
      .eq("id", s.connectionId)
      .maybeSingle();
    if (connErr) throw connErr;
    if (!conn) return { error: "Connection not found" };
    connectionIsManaged = conn.agent_kind === "managed";
    if (connectionIsManaged) {
      const gateError = await managedGateError(orgId);
      if (gateError) return { error: gateError };
    }
    connectionId = conn.id;
    connectionKind = conn.kind;
  } else if (s.newConnection) {
    connectionIsManaged = s.newConnection.type === "managed_agent";
    if (connectionIsManaged) {
      const gateError = await managedGateError(orgId);
      if (gateError) return { error: gateError };
    }
    const res = await insertConnection(orgId, userId, s.newConnection);
    if ("error" in res) return res;
    connectionId = res.connectionId;
    createdConnectionId = res.connectionId;
    connectionKind = isDatasetConnectionType(s.newConnection.type) ? "dataset" : "agent";
  } else {
    return { error: "Select or create a System connection" };
  }

  const cleanupConnection = async () => {
    if (createdConnectionId) {
      await tenantDb(ctx).from("connections").delete().eq("id", createdConnectionId);
    }
  };

  const isDataset = connectionKind === "dataset";
  if (isDataset) {
    if (s.windowMinutes == null || s.maxRows == null) {
      await cleanupConnection();
      return { error: "Dataset schedules need a lookback window and a maximum row count" };
    }
  } else if (s.inputs.length === 0) {
    await cleanupConnection();
    return { error: "At least one input row is required" };
  }

  // Compute initial next_run_at (UTC) via the DB's timezone-aware function.
  const { data: nextRunAt, error: nraErr } = await supabaseAdmin.rpc("compute_next_run_at", {
    p_frequency: s.cadence.frequency,
    p_local_hour: s.cadence.localHour ?? null,
    p_days_of_week: s.cadence.daysOfWeek ?? null,
    p_day_of_month: s.cadence.dayOfMonth ?? null,
    p_timezone: s.cadence.timezone,
  });
  if (nraErr) {
    await log.error("compute_next_run_at failed", {
      event: "schedule.next_run_compute_failed",
      org_id: orgId,
      error: nraErr,
    });
    await cleanupConnection();
    return { error: "Failed to compute the schedule's next run time" };
  }

  const { data: schedule, error: schedErr } = await tenantDb(ctx)
    .from("schedules")
    .insert({
      created_by: userId,
      rubric_id: s.rubricId,
      connection_id: connectionId,
      name: s.name,
      description: s.description ?? null,
      eval_type: "tabular",
      frequency: s.cadence.frequency,
      local_hour: s.cadence.localHour ?? null,
      days_of_week: s.cadence.daysOfWeek ?? null,
      day_of_month: s.cadence.dayOfMonth ?? null,
      timezone: s.cadence.timezone,
      enabled: s.enabled,
      notification_emails: s.notificationEmails ?? [],
      window_minutes: isDataset ? s.windowMinutes : null,
      max_rows: isDataset ? s.maxRows : null,
      next_run_at: nextRunAt,
    })
    .select("id")
    .single();

  if (schedErr || !schedule) {
    await log.error("schedules insert failed", {
      event: "schedule.create_failed",
      org_id: orgId,
      error: schedErr,
    });
    await cleanupConnection();
    return { error: "Failed to create schedule" };
  }

  // Only agent schedules carry a fixed input set; dataset schedules fetch rows at fire time.
  if (!isDataset) {
    const { error: inputsErr } = await supabaseAdmin.from("schedule_inputs").insert(
      s.inputs.map((row, i) => ({
        schedule_id: schedule.id,
        row_index: i,
        user_input: row.userInput,
        expected_output: row.expectedOutput ?? null,
        retrieval_context: row.retrievalContext ?? null,
      }))
    );
    if (inputsErr) {
      await log.error("schedule_inputs insert failed", {
        event: "schedule.inputs_insert_failed",
        schedule_id: schedule.id,
        error: inputsErr,
      });
      await tenantDb(ctx).from("schedules").delete().eq("id", schedule.id);
      await cleanupConnection();
      return { error: "Failed to save the input set" };
    }
  }

  await track(
    {
      name: "schedule.created",
      props: {
        frequency: s.cadence.frequency,
        kind: connectionKind,
        input_count: isDataset ? 0 : s.inputs.length,
      },
    },
    { userId }
  );

  revalidatePath("/schedules");
  return { scheduleId: schedule.id };
}

// ---------- Read ----------

export async function listSchedules() {
  const ctx = await getAuthContext();
  if (!ctx.userId || !ctx.orgId) return [];

  const { data, error } = await tenantDb(ctx)
    .from("schedules")
    .select(
      "id", "name", "frequency", "local_hour", "days_of_week", "day_of_month",
      "timezone", "enabled", "next_run_at", "last_run_at", "created_at"
    )
    .order("created_at", { ascending: false });
  if (error) throw error;

  return data ?? [];
}

export async function getSchedule(id: string) {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  // Stays on the raw admin client: this read pulls a PostgREST embed
  // (`rubrics!inner(...)`, `connections!inner(...)`) that the typed tenantDb
  // `select(...columns)` can't express. It's still org-scoped by the explicit
  // `.eq("org_id", orgId)` below — the helper would add nothing the filter doesn't.
  const { data: schedule, error: scheduleErr } = await supabaseAdmin
    .from("schedules")
    .select(
      "*, rubrics!inner(name), connections!inner(name, endpoint, kind)"
    )
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (scheduleErr) throw scheduleErr;

  if (!schedule) return null;

  const { data: runs, error: runsErr } = await supabaseAdmin
    .from("eval_runs")
    .select("id, status, overall_score, error_message, created_at")
    .eq("schedule_id", id)
    .is("deleted_at", null) // a schedule's run history hides runs aged out of the window (#187)
    .order("created_at", { ascending: false })
    .limit(50);
  if (runsErr) throw runsErr;

  return { schedule, runs: runs ?? [] };
}

// ---------- Enable / disable ----------

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (!canWrite) throw new Error("Only contributors can change schedules");

  const { data: schedule, error: scheduleErr } = await tenantDb(ctx)
    .from("schedules")
    .select("frequency", "local_hour", "days_of_week", "day_of_month", "timezone")
    .eq("id", id)
    .maybeSingle();
  if (scheduleErr) throw scheduleErr;
  if (!schedule) throw new Error("Schedule not found");

  // Re-enabling: recompute next_run_at forward so a stale past time doesn't backfire.
  // Bail if the computation fails or yields null — writing a null next_run_at while
  // enabled=true would leave the schedule enabled but never firing (tick_schedules
  // skips rows where next_run_at is null).
  let nextRunAt: string | undefined;
  if (enabled) {
    const { data, error: rpcError } = await supabaseAdmin.rpc("compute_next_run_at", {
      p_frequency: schedule.frequency,
      p_local_hour: schedule.local_hour,
      p_days_of_week: schedule.days_of_week,
      p_day_of_month: schedule.day_of_month,
      p_timezone: schedule.timezone,
    });
    if (rpcError || data == null) {
      await log.error("compute_next_run_at failed while enabling schedule", {
        event: "schedule.next_run_compute_failed",
        schedule_id: id,
        error: rpcError,
      });
      throw new Error("Failed to compute the schedule's next run time");
    }
    nextRunAt = data as string;
  }

  const { error } = await tenantDb(ctx)
    .from("schedules")
    .update({
      enabled,
      ...(enabled ? { next_run_at: nextRunAt } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    await log.error("schedule enable/disable failed", {
      event: "schedule.toggle_failed",
      schedule_id: id,
      enabled,
      error,
    });
    throw new Error("Failed to update schedule");
  }

  revalidatePath("/schedules");
}

// ---------- Delete ----------

export async function deleteSchedule(id: string): Promise<void> {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (!canWrite) throw new Error("Only contributors can delete schedules");

  const { error } = await tenantDb(ctx).from("schedules").delete().eq("id", id);

  if (error) {
    await log.error("schedule delete failed", {
      event: "schedule.delete_failed",
      schedule_id: id,
      error,
    });
    throw new Error("Failed to delete schedule");
  }

  await track({ name: "schedule.deleted", props: { schedule_id: id } }, { userId });
  revalidatePath("/schedules");
}
