import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { RubricsLayout } from "./_components/rubrics-layout";
import { RubricsHeader } from "./_components/rubrics-header";
import { OnboardingProvider } from "./_components/onboarding/onboarding-context";
import { GettingStartedCard } from "./_components/onboarding/getting-started-card";
import { resolveKeyModeForEstimate, KEY_MODE } from "@/lib/llm/key-gate";
import { getProviderKeyRows } from "@/lib/llm/keys";
import { BillingProvider } from "@/app/_components/billing-context";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";
import type { RubricSummary } from "@/types/rubric";

export default async function RubricsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Contributors (org admins) can create/edit/delete rubrics and run evals;
  // Readonly Members get a view-only surface. Mirrors the server-side guards in
  // createRubric/updateRubric/deleteRubric and createEvalRun.

  // All four reads depend only on orgId, so fetch them in one round trip rather
  // than a serial waterfall: the rubric list, the team-wide KPI aggregate (join
  // eval_runs through rubrics for org scoping), and the billing/key-mode pair
  // the managed-spend estimate needs.
  const [
    { data, error: rubricsErr },
    { data: runRows, error: runRowsErr },
    { plan },
    anthropicKeyMode,
    providerKeyRows,
  ] = await Promise.all([
    tenantDb(ctx)
      .from("rubrics")
      .select("id", "name", "evaluation_mode", "created_at", "criteria")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("eval_runs")
      .select("overall_score, status, rubrics!inner(org_id)")
      .eq("rubrics.org_id", orgId)
      .is("deleted_at", null), // KPI counts must match the (filtered) run list (#187)
    getBillingState(orgId),
    resolveKeyModeForEstimate(orgId, ESTIMATE_JUDGE_PROVIDER),
    getProviderKeyRows(orgId),
  ]);
  if (rubricsErr) throw rubricsErr;
  if (runRowsErr) throw runRowsErr;

  const rubrics: RubricSummary[] = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    evaluation_mode: r.evaluation_mode,
    created_at: r.created_at,
    criteriaCount: Array.isArray(r.criteria) ? r.criteria.length : 0,
  }));

  const runCount = runRows?.length ?? 0;
  const scored = (runRows ?? [])
    .filter((r) => r.status === "completed" && r.overall_score != null)
    .map((r) => Number(r.overall_score));
  const avgScore =
    scored.length > 0
      ? scored.reduce((sum, s) => sum + s, 0) / scored.length
      : null;

  // The managed-spend estimate gates on whether the Team would use a managed Anthropic key, not
  // paid-plan status alone (#185). NOTE: the eval judge is now provider-aware (#204, resolveEvalJudge),
  // so this Anthropic-keyed estimate can over-state for a Team whose eval actually runs BYO on a
  // non-Anthropic key (display-only, never charged). Making the estimate discover the eval judge
  // provider is a tracked follow-up.
  const retentionDays = PLANS[plan].retentionDays;
  const managedEstimatePlan =
    anthropicKeyMode === KEY_MODE.managed ? plan : null;

  // Free Teams have no managed-key fallback, so the guided tutorial leads with
  // the "add a provider key" step (key → rubric → eval); paid Teams skip it.
  const isFreePlan = plan === "free";
  const providerKeyCount = providerKeyRows.filter(
    (r) => r.hasKey && r.runtimeReady,
  ).length;

  return (
    // flex-1 content region below the persistent nav (layout owns the shell).
    <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-2 overflow-hidden px-6 pb-6">
      <RubricsHeader
        rubricCount={rubrics.length}
        runCount={runCount}
        avgScore={avgScore}
      />
      {/* Guided first-run tutorial. Progress is derived from live data (rubric
          and eval-run counts) — no persisted state — and is gated to writers;
          the card and coach-marks vanish once the Team has a rubric and has run
          its first eval. */}
      <OnboardingProvider
        data={{ rubricCount: rubrics.length, runCount, providerKeyCount }}
        canWrite={canWrite}
        isFreePlan={isFreePlan}
      >
        <GettingStartedCard providerKeyRows={providerKeyRows} />
        <BillingProvider
          plan={plan}
          managedEstimatePlan={managedEstimatePlan}
          retentionDays={retentionDays}
        >
          <RubricsLayout rubrics={rubrics} canWrite={canWrite} />
        </BillingProvider>
      </OnboardingProvider>
    </div>
  );
}
