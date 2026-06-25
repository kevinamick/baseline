import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { listOptimizationRuns } from "@/app/actions/optimizations";
import { getOptimizationAllowance } from "@/lib/billing/allowance";
import { PLANS } from "@/lib/billing/plans";
import {
  getOverageCap,
  overageRatesForPlan,
  projectedOverageUsd,
} from "@/lib/billing/overage";
import { OptimizationsLayout } from "./_components/optimizations-layout";
import { usableProvidersForOrg } from "@/lib/llm/usable-providers";
import { StatusPill } from "@/app/_components/status-pill";
import type { RubricSummary } from "@/types/rubric";
import { isActiveOptimizationStatus } from "@/types/optimization";
import type { OptimizableConnection } from "@/types/optimization";

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

  // Runs for the list, plus the two inputs the start wizard needs: the team's rubrics, and the
  // agent Connections that declare ≥1 Module (only those have a {{prompt:*}} to optimize).
  const [
    runs,
    allowance,
    { data: rubrics, error: rubricsErr },
    { data: agentConnections, error: connectionsErr },
    usableProviders,
  ] = await Promise.all([
    listOptimizationRuns(),
    getOptimizationAllowance(orgId),
    supabaseAdmin
      .from("rubrics")
      .select("id, name, evaluation_mode, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    tenantDb(ctx)
      .from("connections")
      .select("id", "name", "optimizable_prompts")
      .eq("kind", "agent")
      .order("created_at", { ascending: false }),
    // Which providers/models the wizard may offer, and which key a run will use (#204).
    usableProvidersForOrg(orgId),
  ]);
  if (rubricsErr) throw rubricsErr;
  if (connectionsErr) throw connectionsErr;

  // Overage headroom (#183): with a cap set and room for one more run's
  // dollar cost, the UI must not hard-disable "+ New run" when included runs
  // are exhausted — the reserve would accept it. Points balance via the raw
  // RPC: reserves can't exist without their grant, so an unmaterialized
  // period simply reads 0.
  const overageRates = overageRatesForPlan(allowance.plan);
  let overageHeadroom = false;
  if (overageRates && allowance.remaining < 1) {
    // The cap and the point balance are independent reads — fetch them together
    // so the cap-set branch costs one round trip, not two. point_balance is
    // harmless when the cap turns out null (we just don't use it).
    const [cap, { data: pointBalance }] = await Promise.all([
      getOverageCap(orgId),
      supabaseAdmin.rpc("point_balance", {
        p_org_id: orgId,
        p_period_start: allowance.periodStart,
      }),
    ]);
    if (cap != null) {
      const committed = projectedOverageUsd(
        Number(pointBalance ?? 0),
        allowance.remaining,
        overageRates,
      );
      overageHeadroom = committed + overageRates.runUnitUsd <= cap;
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

  // One optimization run per org at a time, so the slot is either free ("1
  // available") or held by a live run ("Running"). Mirrors the gate in
  // OptimizationsLayout.
  const hasActiveRun = runs.some((r) => isActiveOptimizationStatus(r.status));

  return (
    // flex-1 content region below the persistent nav (layout owns the shell).
    <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
      <header className="flex shrink-0 flex-col items-start gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <h1 className="sr-only">{t("srTitle")}</h1>
        <p className="text-[15px] text-fg-2">{t("intro")}</p>
        {hasActiveRun ? (
          <StatusPill tone="active" pulse>
            {t("running")}
          </StatusPill>
        ) : (
          <StatusPill tone="positive">{t("oneAvailable")}</StatusPill>
        )}
      </header>
      <OptimizationsLayout
        runs={runs}
        rubrics={(rubrics ?? []) as RubricSummary[]}
        connections={connections}
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
