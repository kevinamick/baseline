import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NavBar } from "@/app/_components/nav-bar";
import { SchedulesLayout } from "./_components/schedules-layout";
import type { RubricSummary } from "@/types/rubric";
import type { ScheduleSummary, ConnectionSummary } from "@/types/schedule";

export default async function SchedulesPage() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return null;

  // Contributors create/edit/enable/delete; Readonly Members get a view-only surface.
  // Mirrors the server-side guards in the schedules/connections actions.
  const canWrite = orgRole === "org:admin";

  const [{ data: schedules }, { data: rubrics }, { data: connections }] = await Promise.all([
    supabaseAdmin
      .from("schedules")
      .select(
        "id, name, frequency, local_hour, days_of_week, day_of_month, timezone, enabled, next_run_at, last_run_at, created_at"
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("rubrics")
      .select("id, name, evaluation_mode, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("connections")
      .select("id, name, kind, provider, endpoint, response_path, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <NavBar />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
        <SchedulesLayout
          schedules={(schedules ?? []) as ScheduleSummary[]}
          rubrics={(rubrics ?? []) as RubricSummary[]}
          connections={(connections ?? []) as ConnectionSummary[]}
          canWrite={canWrite}
        />
      </div>
    </div>
  );
}
