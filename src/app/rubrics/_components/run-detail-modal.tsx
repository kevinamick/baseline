"use client";

import { useEffect, useState } from "react";
import { getEvalRunDetails } from "@/app/actions/eval-runs";
import { Dialog } from "@/app/_components/dialog";
import { scoreColor, StatusBadge } from "@/app/_components/eval-run-helpers";
import { ChevronRightIcon, XIcon } from "@/app/_components/icons";
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
    <Dialog
      onClose={onClose}
      ariaLabelledBy="run-detail-title"
      className="max-w-2xl h-[85vh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-6 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-3">
            Run detail
          </span>
          <h2
            id="run-detail-title"
            className="text-lg font-semibold tracking-[-0.015em]"
          >
            {details?.description ?? "Eval run"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-fg-2 transition-colors hover:bg-paper hover:text-ink"
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {!details ? (
          <p className="text-sm text-fg-4">Loading…</p>
        ) : (
          <>
            {/* Summary tiles */}
            <div className="grid grid-cols-3 gap-3">
              <SummaryTile
                label="Overall"
                tone="accent"
                value={
                  details.overallScore != null
                    ? `${Math.round(details.overallScore * 100)}%`
                    : "—"
                }
              />
              <SummaryTile
                label="Status"
                value={<StatusBadge status={details.status} />}
              />
              <SummaryTile
                label="Rows scored"
                value={
                  <span className="font-mono tabular-nums">
                    {rowIndexes.length}
                  </span>
                }
              />
            </div>

            {details.status === "failed" && (
              <div className="flex items-start gap-2.5 rounded-lg border border-danger bg-danger-bg px-3.5 py-2.5 text-[13px] text-danger-fg">
                <span className="font-semibold">Run failed.</span>
                {details.errorMessage && <span>{details.errorMessage}</span>}
              </div>
            )}

            {rowIndexes.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink">
                  Per-row breakdown
                </h3>
                {rowIndexes.map((rowIdx) => {
                  const rowResults = details.results.filter(
                    (r) => r.rowIndex === rowIdx
                  );
                  const avgScore =
                    rowResults.reduce((s, r) => s + r.score, 0) /
                    rowResults.length;
                  const isOpen = openRows.has(rowIdx);

                  return (
                    <div
                      key={rowIdx}
                      className="overflow-hidden rounded-lg border border-hairline"
                    >
                      <button
                        type="button"
                        onClick={() => toggleRow(rowIdx)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-paper-warm"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`flex text-fg-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          >
                            <ChevronRightIcon size={14} />
                          </span>
                          <span className="text-[13px] font-medium text-ink">
                            Row {rowIdx + 1}
                          </span>
                          <span className="text-xs text-fg-3">
                            {rowResults.length} criteri
                            {rowResults.length === 1 ? "on" : "a"}
                          </span>
                        </div>
                        <span
                          className={`font-mono text-sm font-bold tabular-nums ${scoreColor(avgScore)}`}
                        >
                          {Math.round(avgScore * 100)}%
                        </span>
                      </button>

                      {isOpen && (
                        <div className="flex flex-col gap-3.5 border-t border-hairline bg-paper-warm px-4 py-3.5">
                          {rowResults.map((result) => (
                            <div
                              key={result.criterionName}
                              className="flex flex-col gap-1"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-fg-2">
                                  {result.criterionName}
                                </span>
                                <span
                                  className={`font-mono text-xs font-bold tabular-nums ${scoreColor(result.score)}`}
                                >
                                  {result.score.toFixed(2)}
                                </span>
                              </div>
                              <p className="text-xs leading-normal text-fg-3">
                                {result.reasoning}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-paper-warm px-6 py-3.5">
        <span className="font-mono text-[11px] text-fg-3">{runId}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          Close
        </button>
      </div>
    </Dialog>
  );
}

function SummaryTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "accent";
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg px-4 py-3.5 ${
        tone === "accent" ? "bg-accent" : "bg-card-warm"
      }`}
    >
      <span
        className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${
          tone === "accent" ? "text-fg-on-accent/80" : "text-fg-3"
        }`}
      >
        {label}
      </span>
      <div
        className={`text-[1.35rem] font-semibold ${
          tone === "accent" ? "text-fg-on-accent" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
