import { setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { RubricsLayout } from "./_components/rubrics-layout";
import { RubricsHeader } from "./_components/rubrics-header";
import { OnboardingProvider } from "./_components/onboarding/onboarding-context";
import { GettingStartedCard } from "./_components/onboarding/getting-started-card";
import { countUsableProviders } from "@/lib/llm/key-gate";
import { getProviderKeyRows } from "@/lib/llm/keys";
import type { RubricSummary } from "@/types/rubric";

export default async function RubricsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const ctx = await getAuthContext();
  const { orgId, canWrite } = ctx;

  // All reads depend only on orgId, so fetch them in one round trip rather
  // than a serial waterfall: the rubric list, the Workspace-wide KPI aggregate
  // (join eval_runs through rubrics for org scoping), and the provider-key state
  // the guided tutorial derives its key step from.
  const [
    { data, error: rubricsErr },
    { data: runRows, error: runRowsErr },
    providerKeyRows,
    providerKeyCount,
  ] = await Promise.all([
    tenantDb(ctx)
      .from("rubrics")
      .select("id", "name", "evaluation_mode", "created_at", "criteria")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("eval_runs")
      .select("overall_score, status, rubrics!inner(org_id)")
      .eq("rubrics.org_id", orgId)
      .is("deleted_at", null), // KPI counts must match the (filtered) run list
    getProviderKeyRows(orgId),
    // Vault keys AND the operator's env keys count (ADR-0020): the key step ticks
    // as soon as any runtime-ready provider can run.
    countUsableProviders(orgId),
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
      >
        <GettingStartedCard providerKeyRows={providerKeyRows} />
        <RubricsLayout rubrics={rubrics} canWrite={canWrite} />
      </OnboardingProvider>
    </div>
  );
}
