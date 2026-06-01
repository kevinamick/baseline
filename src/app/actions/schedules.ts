"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { CreateScheduleSchema } from "@/lib/validation/schemas";
import { insertConnection } from "@/lib/connections/create";

// ---------- Create ----------

export async function createSchedule(
  input: z.input<typeof CreateScheduleSchema>
): Promise<{ scheduleId: string } | { error: string }> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (orgRole !== "org:admin") return { error: "Only contributors can create schedules" };

  const parsed = CreateScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid schedule" };
  }
  const s = parsed.data;

  // Verify the rubric belongs to the team.
  const { data: rubric } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", s.rubricId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!rubric) return { error: "Rubric not found" };

  // Resolve the System connection: an existing one (verify ownership) or create inline.
  // We also need its kind: agent schedules carry a fixed input set; dataset schedules
  // carry a sampling window instead. For an existing connection the schema can't see the
  // kind, so we resolve it here and enforce the kind-specific requirements server-side.
  let connectionId: string;
  let connectionKind: string;
  let createdConnectionId: string | null = null;
  if (s.connectionId) {
    const { data: conn } = await supabaseAdmin
      .from("connections")
      .select("id, kind")
      .eq("id", s.connectionId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!conn) return { error: "Connection not found" };
    connectionId = conn.id;
    connectionKind = conn.kind;
  } else if (s.newConnection) {
    const res = await insertConnection(orgId, userId, s.newConnection);
    if ("error" in res) return res;
    connectionId = res.connectionId;
    createdConnectionId = res.connectionId;
    connectionKind = s.newConnection.type === "agent" ? "agent" : "dataset";
  } else {
    return { error: "Select or create a System connection" };
  }

  const cleanupConnection = async () => {
    if (createdConnectionId) {
      await supabaseAdmin.from("connections").delete().eq("id", createdConnectionId);
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
    console.error("compute_next_run_at failed", nraErr);
    await cleanupConnection();
    return { error: "Failed to compute the schedule's next run time" };
  }

  const { data: schedule, error: schedErr } = await supabaseAdmin
    .from("schedules")
    .insert({
      org_id: orgId,
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
    console.error("schedules insert failed", schedErr);
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
      console.error("schedule_inputs insert failed", inputsErr);
      await supabaseAdmin.from("schedules").delete().eq("id", schedule.id);
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
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return [];

  const { data } = await supabaseAdmin
    .from("schedules")
    .select(
      "id, name, frequency, local_hour, days_of_week, day_of_month, timezone, enabled, next_run_at, last_run_at, created_at"
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  return data ?? [];
}

export async function getSchedule(id: string) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return null;

  const { data: schedule } = await supabaseAdmin
    .from("schedules")
    .select(
      "*, rubrics!inner(name), connections!inner(name, endpoint, kind)"
    )
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!schedule) return null;

  const { data: runs } = await supabaseAdmin
    .from("eval_runs")
    .select("id, status, overall_score, error_message, created_at")
    .eq("schedule_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  return { schedule, runs: runs ?? [] };
}

// ---------- Enable / disable ----------

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (orgRole !== "org:admin") throw new Error("Only contributors can change schedules");

  const { data: schedule } = await supabaseAdmin
    .from("schedules")
    .select("frequency, local_hour, days_of_week, day_of_month, timezone")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
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
      console.error("compute_next_run_at failed while enabling schedule", id, rpcError);
      throw new Error("Failed to compute the schedule's next run time");
    }
    nextRunAt = data as string;
  }

  const { error } = await supabaseAdmin
    .from("schedules")
    .update({
      enabled,
      ...(enabled ? { next_run_at: nextRunAt } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("org_id", orgId);

  if (error) {
    console.error("schedule enable/disable failed", error);
    throw new Error("Failed to update schedule");
  }

  revalidatePath("/schedules");
}

// ---------- Delete ----------

export async function deleteSchedule(id: string): Promise<void> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) throw new Error("Not authenticated");
  if (orgRole !== "org:admin") throw new Error("Only contributors can delete schedules");

  const { error } = await supabaseAdmin
    .from("schedules")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);

  if (error) {
    console.error("schedule delete failed", error);
    throw new Error("Failed to delete schedule");
  }

  await track({ name: "schedule.deleted", props: { schedule_id: id } }, { userId });
  revalidatePath("/schedules");
}
