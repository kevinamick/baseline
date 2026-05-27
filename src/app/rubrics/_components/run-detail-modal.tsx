"use client";

import { useEffect, useState } from "react";
import { getEvalRunDetails } from "@/app/actions/eval-runs";
import { scoreColor, StatusBadge } from "./eval-run-helpers";
import type { EvalRunDetails } from "@/types/eval-run";

export function RunDetailModal({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<EvalRunDetails | null>(null);
  // Set<number> rather than a single index so multiple rows can be open at once.
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());

  useEffect(() => {
    getEvalRunDetails(runId).then(setDetails);
  }, [runId]);

  // Copy-before-mutate: React compares state by reference, so mutating the
  // existing Set in place won't trigger a re-render — we need a new Set object.
  function toggleRow(i: number) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); } else { next.add(i); }
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
            <span className={`text-lg font-bold ${scoreColor(details.overallScore)}`}>
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
              <p className="text-sm font-medium text-red-700 dark:text-red-400">Run failed</p>
              {details.errorMessage && (
                <p className="text-xs text-red-600 dark:text-red-500 mt-1">{details.errorMessage}</p>
              )}
            </div>
          ) : rowIndexes.length === 0 ? (
            <p className="text-sm text-zinc-400">No results yet.</p>
          ) : (
            rowIndexes.map((rowIdx) => {
              const rowResults = details.results.filter((r) => r.rowIndex === rowIdx);
              const avgScore = rowResults.reduce((s, r) => s + r.score, 0) / rowResults.length;
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
                            <span className={`text-xs font-semibold ${scoreColor(result.score)}`}>
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
