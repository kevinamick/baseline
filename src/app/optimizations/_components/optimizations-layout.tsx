"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClientDate } from "@/app/_components/client-date";
import { StatusBadge } from "@/app/_components/eval-run-helpers";
import { getOptimizationRun } from "@/app/actions/optimizations";
import type { OptimizationRunSummary } from "@/types/optimization";
import type { EvalRunStatus } from "@/types/eval-run";

interface Props {
  runs: OptimizationRunSummary[];
  canWrite: boolean;
}

type RunDetail = Awaited<ReturnType<typeof getOptimizationRun>>;

export function OptimizationsLayout({ runs }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The URL is the source of truth for which run is open (?run=<id>), so a deep link
  // from an email opens the right run. Fall back to the newest run when unspecified.
  const runParam = searchParams.get("run");
  const selectedId = runParam ?? runs[0]?.id ?? null;

  const [detail, setDetail] = useState<RunDetail>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    // selectedId is only null when there are no runs at all; the JSX guards that case,
    // so there's nothing to fetch and no stale detail to clear.
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      setLoadingDetail(true);
      try {
        const d = await getOptimizationRun(selectedId);
        if (!cancelled) setDetail(d);
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  function selectRun(id: string) {
    // Reflect the selection in the URL without a full navigation (deep-linkable).
    router.replace(`/optimizations?run=${id}`, { scroll: false });
  }

  const run = detail?.run as Record<string, unknown> | undefined;

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      {/* List */}
      <div className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl border border-hairline-cool bg-white">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Optimizations</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {runs.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-zinc-500">
              No optimization runs yet.
            </p>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRun(r.id)}
                className={`mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  selectedId === r.id ? "bg-accent-soft" : "hover:bg-card-warm"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{r.connection_name}</span>
                  <StatusBadge status={r.status as EvalRunStatus} />
                </div>
                <span className="text-[11px] text-zinc-400">
                  <ClientDate value={r.created_at} relative />
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline-cool bg-white">
        {!selectedId || !run ? (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
            {loadingDetail ? "Loading…" : runs.length === 0 ? "No runs to show" : "Select a run"}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-[-0.015em] text-ink">
                  {detailNested(run, "connections", "name")}
                </h2>
                <p className="mt-0.5 text-sm text-zinc-500">
                  Started <ClientDate value={run.created_at as string} />
                </p>
              </div>
              <StatusBadge
                status={run.status as EvalRunStatus}
                title={(run.error_message as string | null) ?? undefined}
              />
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Detail label="Rubric" value={detailNested(run, "rubrics", "name")} />
              <Detail label="Agent" value={detailNested(run, "connections", "name")} />
              <Detail label="Instances" value={String(detail?.instanceCount ?? 0)} />
              <Detail label="Rollout budget" value={String(run.budget_rollouts ?? "—")} />
              <Detail label="Max iterations" value={String(run.max_iters ?? "—")} />
              <Detail
                label="Plateau patience"
                value={run.plateau_patience == null ? "Off" : String(run.plateau_patience)}
              />
              <Detail label="Reflection model" value={String(run.reflect_model ?? "—")} />
              <Detail
                label="Best score"
                value={run.best_score == null ? "—" : `${(Number(run.best_score) * 100).toFixed(0)}%`}
              />
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="break-words text-ink">{value}</dd>
    </div>
  );
}

function detailNested(obj: Record<string, unknown>, rel: string, key: string): string {
  const nested = obj[rel];
  if (Array.isArray(nested)) return String((nested[0] as Record<string, unknown>)?.[key] ?? "—");
  if (nested && typeof nested === "object") return String((nested as Record<string, unknown>)[key] ?? "—");
  return "—";
}
