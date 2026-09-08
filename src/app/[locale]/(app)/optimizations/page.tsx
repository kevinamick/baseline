import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { listOptimizationRuns } from "@/app/actions/optimizations";
import { listEvalRunsForInstanceSeed } from "@/app/actions/eval-runs";
import { OptimizationsLayout } from "./_components/optimizations-layout";
import { usableProvidersForOrg } from "@/lib/llm/usable-providers";
import { StatusPill } from "@/app/_components/status-pill";
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
  const { orgId, canWrite } = ctx;

  // Runs for the list, plus the inputs the start wizard needs: the team's rubrics, the agent
  // Connections that declare ≥1 Module (only those have a {{prompt:*}} to optimize), the
  // dataset Connections eligible for the Instances step's snapshot source (#82), and the Team's
  // Eval Runs eligible for the "From an Eval Run" source (#83).
  // Which providers/models the wizard may offer, and which key a run will use (#204) — a fast
  // DB-only read (provider_keys), awaited with the rest of the page content below. The
  // BYO providers' LIVE model lists (#485) are deliberately NOT fetched here (#488): they hit each
  // provider's list-models API, so a slow/unreachable provider would block the page's TTFB up to
  // the module's 3s timeout. The client layout loads them on demand when the wizard opens (the
  // loadWizardLiveModels server action), so curated DB-sourced content paints immediately.
  const usableProvidersPromise = usableProvidersForOrg(orgId);

  const [
    runs,
    { data: rubrics, error: rubricsErr },
    { data: agentConnections, error: connectionsErr },
    { data: datasetConnectionRows, error: datasetConnectionsErr },
    evalRunOptions,
    usableProviders,
  ] = await Promise.all([
    listOptimizationRuns(),
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
    usableProvidersPromise,
  ]);
  if (rubricsErr) throw rubricsErr;
  if (connectionsErr) throw connectionsErr;
  if (datasetConnectionsErr) throw datasetConnectionsErr;

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
        rubrics={
          (rubrics ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            evaluation_mode: r.evaluation_mode,
            created_at: r.created_at,
            criteriaCount: Array.isArray(r.criteria) ? r.criteria.length : 0,
          })) as RubricSummary[]
        }
        connections={connections}
        datasetConnections={datasetConnections}
        evalRunOptions={evalRunOptions}
        usableProviders={usableProviders}
        canWrite={canWrite}
      />
    </div>
  );
}
