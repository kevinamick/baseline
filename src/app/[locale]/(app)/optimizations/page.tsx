import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { listOptimizationRuns } from "@/app/actions/optimizations";
import { listEvalRunsForInstanceSeed } from "@/app/actions/eval-runs";
import { getOptimizationAllowance } from "@/lib/billing/allowance";
import { PLANS } from "@/lib/billing/plans";
import {
  getOverageCap,
  overageRatesForPlan,
  projectedOverageUsd,
} from "@/lib/billing/overage";
import { OptimizationsLayout } from "./_components/optimizations-layout";
import { usableProvidersForOrg } from "@/lib/llm/usable-providers";
import { OptimizationStatusPills } from "./_components/optimization-status-pills";
import type { RubricSummary } from "@/types/rubric";
import { isActiveOptimizationStatus } from "@/types/optimization";
import type { OptimizableConnection, DatasetConnectionOption } from "@/types/optimization";

export default async function OptimizationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Optimizations" });

  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Runs for the list, plus the inputs the start wizard needs: the team's rubrics, the agent
  // Connections that declare ≥1 Module (only those have a {{prompt:*}} to optimize), the
  // dataset Connections eligible for the Instances step's snapshot source (#82), and the Team's
  // Eval Runs eligible for the "From an Eval Run" source (#83).
  const [
    runs,
    allowance,
    { data: rubrics, error: rubricsErr },
    { data: agentConnections, error: connectionsErr },
    { data: datasetConnectionRows, error: datasetConnectionsErr },
    evalRunOptions,
    usableProviders,
  ] = await Promise.all([
    listOptimizationRuns(),
    getOptimizationAllowance(orgId),
    tenantDb(ctx)
      .from("rubrics")
      .select("id", "name", "evaluation_mode", "created_at", "criteria")
      .order("created_at", { ascending: false }),
    tenantDb(ctx)
      .from("connections")
      .select("id", "name", "optimizable_prompts")
      .eq("kind", "agent")
      .order("created_at", { ascending: false }),
    tenantDb(ctx)
      .from("connections")
      .select("id", "name")
      .eq("kind", "dataset")
      .order("created_at", { ascending: false }),
    listEvalRunsForInstanceSeed(),
    // Which providers/models the wizard may offer, and which key a run will use (#204).
    usableProvidersForOrg(orgId),
  ]);
  if (rubricsErr) throw rubricsErr;
  if (connectionsErr) throw connectionsErr;
  if (datasetConnectionsErr) throw datasetConnectionsErr;

  // Overage headroom (ADR-0016): once a PAID Team's included runs are gone, an
  // extra run draws Eval Points, so the UI must not hard-disable "+ New run"
  // when the team can still pay in points — either from a positive point
  // balance or from cap-backed overage. Free (included === 0) is never given
  // headroom: its run wall stays. The exact per-run point cost is enforced at
  // reserve; here we only decide whether to keep the button live. Point balance
  // via the raw RPC: reserves can't exist without their grant, so an
  // unmaterialized period simply reads 0.
  const overageRates = overageRatesForPlan(allowance.plan);
  let overageHeadroom = false;
  if (allowance.included > 0 && allowance.remaining < 1) {
    const { data: pointBalance } = await supabaseAdmin.rpc("point_balance", {
      p_org_id: orgId,
      p_period_start: allowance.periodStart,
    });
    const balance = Number(pointBalance ?? 0);
    if (balance > 0) {
      overageHeadroom = true;
    } else if (overageRates) {
      const cap = await getOverageCap(orgId);
      if (cap != null) {
        overageHeadroom = projectedOverageUsd(balance, overageRates) < cap;
      }
    }
  }

  const connections: OptimizableConnection[] = (agentConnections ?? [])
    .map((c) => ({
      id: c.id,
      name: c.name,
      modules: Array.isArray(c.optimizable_prompts)
        ? (c.optimizable_prompts as { name?: unknown }[])
            .map((m) => String(m?.name ?? ""))
            .filter(Boolean)
        : [],
    }))
    .filter((c) => c.modules.length > 0);

  const datasetConnections: DatasetConnectionOption[] = (datasetConnectionRows ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  // One optimization run per org at a time, so the Active Runs slot (#467) is either
  // free (0/1) or held by a live run (1/1). Mirrors the gate in OptimizationsLayout.
  const hasActiveRun = runs.some((r) => isActiveOptimizationStatus(r.status));

  return (
    // flex-1 content region below the persistent nav (layout owns the shell).
    <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
      <header className="flex shrink-0 flex-col items-start gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <h1 className="sr-only">{t("srTitle")}</h1>
        <p className="text-[15px] text-fg-2">{t("intro")}</p>
        <OptimizationStatusPills hasActiveRun={hasActiveRun} runsRemaining={allowance.remaining} />
      </header>
      <OptimizationsLayout
        runs={runs}
        rubrics={
          (rubrics ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            evaluation_mode: r.evaluation_mode,
            created_at: r.created_at,
            // Criterion count drives the wizard's pre-run Eval Point projection (ADR-0016).
            criteriaCount: Array.isArray(r.criteria) ? r.criteria.length : 0,
          })) as RubricSummary[]
        }
        connections={connections}
        datasetConnections={datasetConnections}
        evalRunOptions={evalRunOptions}
        usableProviders={usableProviders}
        // The Managed Agent path runs its target on Baseline's managed key — paid-only (#204).
        // managedMarkupPct != null is the "managed allowed" / paid signal (Free is null).
        isPaid={PLANS[allowance.plan].managedMarkupPct != null}
        canWrite={canWrite}
        allowance={{
          included: allowance.included,
          remaining: allowance.remaining,
          maxBudgetRollouts: allowance.maxBudgetRollouts,
          overageHeadroom,
        }}
        retentionDays={PLANS[allowance.plan].retentionDays}
      />
    </div>
  );
}
