"use client";

import { useEffect, useRef, useState } from "react";
import { getEvalRuns, getEvalRunDetails } from "@/app/actions/eval-runs";
import { track } from "@/lib/analytics/client";
import { RunEvalDialog } from "./run-eval-dialog";
import type { EvalRun, EvalRunDetails, EvalRunStatus } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";

interface Props {
  selectedRubricId: string | null;
  rubrics: RubricSummary[];
}

export function RunsPanel({ selectedRubricId, rubrics }: Props) {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setRuns([]);

    if (!selectedRubricId) return;

    setLoading(true);
    getEvalRuns(selectedRubricId).then((data) => {
      setRuns(data);
      setLoading(false);
    });

    pollRef.current = setInterval(async () => {
      const data = await getEvalRuns(selectedRubricId);
      setRuns(data);
    }, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selectedRubricId]);

  // Stop polling when no active runs
  useEffect(() => {
    const hasActive = runs.some(
      (r) => r.status === "queued" || r.status === "running"
    );
    if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [runs]);

  function handleRunCreated(run: EvalRun) {
    setRuns((prev) => [run, ...prev]);
    // Re-enable polling
    if (!pollRef.current && selectedRubricId) {
      pollRef.current = setInterval(async () => {
        const data = await getEvalRuns(selectedRubricId!);
        setRuns(data);
      }, 5000);
    }
  }

  return (
    <>
      <div className="flex-1 flex flex-col overflow-hidden rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <h2 className="text-sm font-semibold">Eval runs</h2>
          {selectedRubricId && (
            <button
              onClick={() => {
                track({ name: "eval_run.dialog_opened" });
                setShowDialog(true);
              }}
              className="text-xs px-3 py-1.5 rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
            >
              + Run eval
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {!selectedRubricId ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-zinc-400">
                Select a rubric to view its runs
              </p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-zinc-400">Loading…</p>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p className="text-sm text-zinc-400">No runs yet</p>
              <button
                onClick={() => {
                  track({ name: "eval_run.dialog_opened" });
                  setShowDialog(true);
                }}
                className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                Run your first eval →
              </button>
            </div>
          ) : (
            <ul className="p-2 flex flex-col gap-1.5">
              {runs.map((run) => (
                <li key={run.id} className="list-none">
                  <button
                    type="button"
                    onClick={() =>
                      run.status === "completed" || run.status === "failed"
                        ? setDetailRunId(run.id)
                        : undefined
                    }
                    className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 transition-colors ${
                      run.status === "completed" || run.status === "failed"
                        ? "hover:bg-zinc-100 dark:hover:bg-zinc-700/60 cursor-pointer"
                        : "cursor-default"
                    }`}
                  >
                    <StatusBadge status={run.status} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {run.description ?? new Date(run.createdAt).toLocaleString()}
                      </p>
                      {run.description && (
                        <p className="text-xs text-zinc-400 mt-0.5">
                          {new Date(run.createdAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    {run.overallScore != null && (
                      <span
                        className={`text-sm font-semibold shrink-0 ${scoreColor(run.overallScore)}`}
                      >
                        {Math.round(run.overallScore * 100)}%
                      </span>
                    )}
                    {(run.status === "completed" || run.status === "failed") && (
                      <ChevronRightIcon />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {showDialog && (
        <RunEvalDialog
          rubrics={rubrics}
          initialRubricId={selectedRubricId}
          onClose={() => setShowDialog(false)}
          onCreated={handleRunCreated}
        />
      )}

      {detailRunId && (
        <RunDetailModal
          runId={detailRunId}
          onClose={() => setDetailRunId(null)}
        />
      )}
    </>
  );
}

// ---------- Run detail modal ----------

function RunDetailModal({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<EvalRunDetails | null>(null);
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());

  useEffect(() => {
    getEvalRunDetails(runId).then(setDetails);
  }, [runId]);

  function toggleRow(i: number) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  const rowIndexes = details
    ? [...new Set(details.results.map((r) => r.rowIndex))].sort((a, b) => a - b)
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl h-[85vh] flex flex-col rounded-xl bg-white dark:bg-zinc-900 shadow-xl border border-zinc-200 dark:border-zinc-800 mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold">Run details</h2>
            {details && <StatusBadge status={details.status} />}
          </div>
          {details?.overallScore != null && (
            <span
              className={`text-lg font-bold ${scoreColor(details.overallScore)}`}
            >
              {Math.round(details.overallScore * 100)}%
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none transition-colors ml-4"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 flex flex-col gap-3">
          {!details ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : details.status === "failed" ? (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-4">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                Run failed
              </p>
              {details.errorMessage && (
                <p className="text-xs text-red-600 dark:text-red-500 mt-1">
                  {details.errorMessage}
                </p>
              )}
            </div>
          ) : rowIndexes.length === 0 ? (
            <p className="text-sm text-zinc-400">No results yet.</p>
          ) : (
            rowIndexes.map((rowIdx) => {
              const rowResults = details.results.filter(
                (r) => r.rowIndex === rowIdx
              );
              const avgScore =
                rowResults.reduce((s, r) => s + r.score, 0) / rowResults.length;
              const isOpen = openRows.has(rowIdx);

              return (
                <div
                  key={rowIdx}
                  className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => toggleRow(rowIdx)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <span className="font-medium">Row {rowIdx + 1}</span>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-semibold ${scoreColor(avgScore)}`}>
                        {Math.round(avgScore * 100)}%
                      </span>
                      <ChevronIcon open={isOpen} />
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-zinc-200 dark:border-zinc-700 px-4 py-3 flex flex-col gap-3">
                      {rowResults.map((result) => (
                        <div key={result.criterionName} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                              {result.criterionName}
                            </span>
                            <span
                              className={`text-xs font-semibold ${scoreColor(result.score)}`}
                            >
                              {result.score.toFixed(2)}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                            {result.reasoning}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Helpers ----------

function scoreColor(score: number): string {
  if (score >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

const STATUS_CONFIG: Record<
  EvalRunStatus,
  { label: string; className: string }
> = {
  queued: { label: "Queued", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  running: { label: "Running", className: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400" },
  completed: { label: "Completed", className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400" },
};

function StatusBadge({ status }: { status: EvalRunStatus }) {
  const { label, className } = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${className}`}>
      {status === "running" && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
      )}
      {label}
    </span>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 shrink-0">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
