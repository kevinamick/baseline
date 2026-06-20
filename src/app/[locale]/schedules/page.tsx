import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { NavBar } from "@/app/_components/nav-bar";
import { SchedulesLayout } from "./_components/schedules-layout";
import { StatusPill } from "@/app/_components/status-pill";
import type { RubricSummary } from "@/types/rubric";
import type { ScheduleSummary, ConnectionSummary } from "@/types/schedule";

export default async function SchedulesPage() {
  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Contributors create/edit/enable/delete; Readonly Members get a view-only surface.
  // Mirrors the server-side guards in the schedules/connections actions.

  const [{ data: schedules }, { data: rubrics }, { data: connections }] = await Promise.all([
    tenantDb(ctx)
      .from("schedules")
      .select(
        "id", "name", "frequency", "local_hour", "days_of_week", "day_of_month",
        "timezone", "enabled", "next_run_at", "last_run_at", "created_at"
      )
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("rubrics")
      .select("id, name, evaluation_mode, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    tenantDb(ctx)
      .from("connections")
      .select("id", "name", "kind", "provider", "endpoint", "response_path", "created_at")
      .order("created_at", { ascending: false }),
  ]);

  const scheduleList = (schedules ?? []) as ScheduleSummary[];
  const activeCount = scheduleList.filter((s) => s.enabled).length;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <NavBar />
      <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
        <header className="flex shrink-0 items-center justify-between gap-6 py-2">
          <h1 className="sr-only">Schedules</h1>
          <p className="text-[15px] text-fg-2">
            Schedule recurring evals on the left. Their cadence, recipients, and run history show on the right.
          </p>
          <StatusPill tone={activeCount > 0 ? "positive" : "neutral"}>
            {activeCount} active
          </StatusPill>
        </header>
        <SchedulesLayout
          schedules={scheduleList}
          rubrics={(rubrics ?? []) as RubricSummary[]}
          connections={(connections ?? []) as ConnectionSummary[]}
          canWrite={canWrite}
        />
      </div>
    </div>
  );
}
