import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { RubricsLayout } from "./_components/rubrics-layout";
import { RubricsHeader } from "./_components/rubrics-header";
import { NavBar } from "@/app/_components/nav-bar";
import { managedEstimatePlanForOrg } from "@/lib/llm/key-gate";
import { BillingProvider } from "@/app/_components/billing-context";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import type { RubricSummary } from "@/types/rubric";

export default async function RubricsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Contributors (org admins) can create/edit/delete rubrics and run evals;
  // Readonly Members get a view-only surface. Mirrors the server-side guards in
  // createRubric/updateRubric/deleteRubric and createEvalRun.

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("id, name, evaluation_mode, created_at, criteria")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  const rubrics: RubricSummary[] = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    evaluation_mode: r.evaluation_mode,
    created_at: r.created_at,
    criteriaCount: Array.isArray(r.criteria) ? r.criteria.length : 0,
  }));

  // Team-wide KPI aggregates — join eval_runs through rubrics for org scoping.
  const { data: runRows } = await supabaseAdmin
    .from("eval_runs")
    .select("overall_score, status, rubrics!inner(org_id)")
    .eq("rubrics.org_id", orgId)
    .is("deleted_at", null); // KPI counts must match the (filtered) run list (#187)

  const runCount = runRows?.length ?? 0;
  const scored = (runRows ?? [])
    .filter((r) => r.status === "completed" && r.overall_score != null)
    .map((r) => Number(r.overall_score));
  const avgScore =
    scored.length > 0
      ? scored.reduce((sum, s) => sum + s, 0) / scored.length
      : null;

  // Price the run dialog's managed-spend estimate against the Team's plan when it
  // runs on the managed key (#185); null for BYO/Free. Seeded into BillingProvider
  // so the dialog reads it via context instead of being prop-drilled through the
  // layout/panel layers.
  const managedEstimatePlan = await managedEstimatePlanForOrg(orgId);

  // The plan's Retention Window labels how far back the run list reaches (#187).
  const { plan } = await getBillingState(orgId);
  const retentionDays = PLANS[plan].retentionDays;

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-paper">
      <NavBar />
      <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-2 overflow-hidden px-6 pb-6">
        <RubricsHeader
          rubricCount={rubrics.length}
          runCount={runCount}
          avgScore={avgScore}
        />
        <BillingProvider
          managedEstimatePlan={managedEstimatePlan}
          retentionDays={retentionDays}
        >
          <RubricsLayout rubrics={rubrics} canWrite={canWrite} />
        </BillingProvider>
      </div>
    </div>
  );
}
