"use client";

import { useEffect, useRef, useState } from "react";
import { getEvalRuns } from "@/app/actions/eval-runs";
import { track } from "@/lib/analytics/client";
import { RunEvalDialog } from "./run-eval-dialog";
import { RunDetailModal } from "./run-detail-modal";
import { scoreColor, StatusBadge } from "./eval-run-helpers";
import type { EvalRun } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";

const POLL_INTERVAL_MS = 5000;

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

  function startPolling(rubricId: string) {
    pollRef.current = setInterval(async () => {
      const data = await getEvalRuns(rubricId);
      setRuns(data);
    }, POLL_INTERVAL_MS);
  }

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setRuns([]);

    if (!selectedRubricId) return;

    setLoading(true);
    getEvalRuns(selectedRubricId).then((data) => {
      setRuns(data);
      setLoading(false);
    });

    startPolling(selectedRubricId);

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
    if (!pollRef.current && selectedRubricId) {
      startPolling(selectedRubricId);
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

function ChevronRightIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-zinc-400 shrink-0"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
