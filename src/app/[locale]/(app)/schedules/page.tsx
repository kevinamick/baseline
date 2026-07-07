import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { SchedulesLayout } from "./_components/schedules-layout";
import { StatusPill } from "@/app/_components/status-pill";
import type { RubricSummary } from "@/types/rubric";
import type { ScheduleSummary, ConnectionSummary } from "@/types/schedule";

export default async function SchedulesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Schedules" });

  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Contributors create/edit/enable/delete; Readonly Members get a view-only surface.
  // Mirrors the server-side guards in the schedules/connections actions.

  const [
    { data: schedules, error: schedulesErr },
    { data: rubrics, error: rubricsErr },
    { data: connections, error: connectionsErr },
    billing,
  ] = await Promise.all([
    tenantDb(ctx)
      .from("schedules")
      .select(
        "id",
        "name",
        "frequency",
        "local_hour",
        "days_of_week",
        "day_of_month",
        "timezone",
        "enabled",
        "next_run_at",
        "last_run_at",
        "created_at",
      )
      .order("created_at", { ascending: false }),
    tenantDb(ctx)
      .from("rubrics")
      .select("id", "name", "evaluation_mode", "created_at")
      .order("created_at", { ascending: false }),
    tenantDb(ctx)
      .from("connections")
      .select(
        "id",
        "name",
        "kind",
        "provider",
        "agent_kind",
        "endpoint",
        "response_path",
        "created_at",
      )
      .order("created_at", { ascending: false }),
    getBillingState(orgId),
  ]);
  if (schedulesErr) throw schedulesErr;
  if (rubricsErr) throw rubricsErr;
  if (connectionsErr) throw connectionsErr;

  const scheduleList = (schedules ?? []) as ScheduleSummary[];
  const activeCount = scheduleList.filter((s) => s.enabled).length;

  // A Managed Agent runs on Baseline's managed key — a paid-plan feature (managedMarkupPct == null
  // ⇔ Free). The wizard uses this to disable the managed option with an upgrade CTA; createSchedule
  // is the server-authoritative gate (#292) regardless.
  const managedAllowed = PLANS[billing.plan].managedMarkupPct != null;

  return (
    // flex-1 content region below the persistent nav (layout owns the shell).
    <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
      <header className="flex shrink-0 flex-col items-start gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <h1 className="sr-only">{t("srTitle")}</h1>
        <p className="text-[15px] text-fg-2">{t("intro")}</p>
        <StatusPill tone={activeCount > 0 ? "positive" : "neutral"}>
          {t("active", { count: activeCount })}
        </StatusPill>
      </header>
      <SchedulesLayout
        schedules={scheduleList}
        rubrics={(rubrics ?? []) as RubricSummary[]}
        connections={(connections ?? []) as ConnectionSummary[]}
        canWrite={canWrite}
        managedAllowed={managedAllowed}
      />
    </div>
  );
}
