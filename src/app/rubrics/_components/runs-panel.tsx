"use client";

import { useEffect, useRef, useState } from "react";
import { getEvalRuns } from "@/app/actions/eval-runs";
import { track } from "@/lib/analytics/client";
import { RunEvalDialog } from "./run-eval-dialog";
import { RunDetailModal } from "./run-detail-modal";
import { RunComparisonModal } from "./run-comparison-modal";
import { ClientDate } from "@/app/_components/client-date";
import { scoreColor, StatusBadge } from "@/app/_components/eval-run-helpers";
import { ScoreWithTooltip } from "@/app/_components/score-with-tooltip";
import {
  ChevronRightIcon,
  PlayIcon,
  SparklesIcon,
} from "@/app/_components/icons";
import type { EvalRun } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";
import type { PlanSlug } from "@/lib/billing/plans";

const POLL_INTERVAL_MS = 5000;

interface Props {
  selectedRubricId: string | null;
  rubrics: RubricSummary[];
  canWrite: boolean;
  /** Plan to price the run dialog's managed-spend estimate (#185); null = none. */
  managedEstimatePlan?: PlanSlug | null;
}

export function RunsPanel({
  selectedRubricId,
  rubrics,
  canWrite,
  managedEstimatePlan = null,
}: Props) {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelections, setCompareSelections] = useState<string[]>([]);
  const [comparisonIds, setComparisonIds] = useState<[string, string] | null>(null);
  const [prevRubricId, setPrevRubricId] = useState(selectedRubricId);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Exit compare mode when the selected rubric changes. Done as a render-time
  // reset (React's recommended alternative to a setState-in-effect) so the stale
  // compare UI never paints for the newly-selected rubric.
  if (selectedRubricId !== prevRubricId) {
    setPrevRubricId(selectedRubricId);
    setCompareMode(false);
    setCompareSelections([]);
  }

  function startPolling(rubricId: string) {
    pollRef.current = setInterval(async () => {
      const data = await getEvalRuns(rubricId);
      setRuns(data);
    }, POLL_INTERVAL_MS);
  }

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    if (!selectedRubricId) {
      Promise.resolve().then(() => setRuns([]));
      return;
    }

    const fetchAndPoll = async () => {
      setLoading(true);
      const data = await getEvalRuns(selectedRubricId);
      setRuns(data);
      setLoading(false);
      startPolling(selectedRubricId);
    };

    fetchAndPoll();

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

  function handleToggleCompareSelection(runId: string) {
    setCompareSelections((prev) => {
      if (prev.includes(runId)) return prev.filter((id) => id !== runId);
      if (prev.length >= 2) return [prev[1], runId];
      return [...prev, runId];
    });
  }

  function handleOpenComparison() {
    if (compareSelections.length === 2) {
      setComparisonIds([compareSelections[0], compareSelections[1]]);
    }
  }

  function handleExitCompareMode() {
    setCompareMode(false);
    setCompareSelections([]);
  }

  // The newest in-progress run gets the dark "focus" card treatment.
  const activeRun = runs.find(
    (r) => r.status === "running" || r.status === "queued"
  );
  const otherRuns = runs.filter((r) => r !== activeRun);
  const completedRuns = runs.filter(
    (r) => r.status === "completed" || r.status === "failed"
  );
  const canShowCompare = completedRuns.length >= 2;

  return (
    <>
      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
        {/* Header */}
        <div className="flex min-h-[60px] shrink-0 items-center justify-between border-b border-hairline px-5 py-4">
          {compareMode ? (
            <>
              <h2 className="text-base font-semibold tracking-[-0.01em]">
                {compareSelections.length === 0
                  ? "Select 2 runs"
                  : compareSelections.length === 1
                    ? "Select 1 more"
                    : "2 runs selected"}
              </h2>
              <div className="flex items-center gap-2">
                {compareSelections.length === 2 && (
                  <button
                    onClick={handleOpenComparison}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-fg-on-accent transition-colors hover:bg-accent-hover"
                  >
                    Compare
                  </button>
                )}
                <button
                  onClick={handleExitCompareMode}
                  className="rounded-full border border-hairline-cool bg-card px-3 py-1.5 text-xs text-fg-2 transition-colors hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold tracking-[-0.01em]">
                {selectedRubricId ? (
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium text-fg-3">Eval runs</span>
                    <span className="text-fg-3">/</span>
                    <span>
                      {rubrics.find((r) => r.id === selectedRubricId)?.name}
                    </span>
                  </span>
                ) : (
                  "Eval runs"
                )}
              </h2>
              <div className="flex items-center gap-2">
                {selectedRubricId && canShowCompare && (
                  <button
                    onClick={() => setCompareMode(true)}
                    className="rounded-full border border-hairline-cool bg-card px-3 py-1.5 text-xs text-fg-2 transition-colors hover:text-ink"
                  >
                    Compare
                  </button>
                )}
                {selectedRubricId && canWrite && (
                  <button
                    onClick={() => {
                      track({ name: "eval_run.dialog_opened" });
                      setShowDialog(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-fg-on-accent transition-colors hover:bg-accent-hover"
                  >
                    <PlayIcon size={11} /> Run eval
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-1.5">
          {!selectedRubricId ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <SplitPaneIllustration />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-ink">Select a rubric</p>
                <p className="text-xs text-fg-3">
                  Choose a rubric from the list to view its eval runs
                </p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-fg-3">Loading…</p>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5">
              <p className="text-sm text-fg-3">No runs yet</p>
              {canWrite && (
                <button
                  onClick={() => {
                    track({ name: "eval_run.dialog_opened" });
                    setShowDialog(true);
                  }}
                  className="text-sm font-medium text-fg-2 transition-colors hover:text-ink"
                >
                  Run your first eval →
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-1">
              {!compareMode && activeRun && <ActiveRunCard run={activeRun} />}
              {(compareMode ? runs : otherRuns).map((run) => {
                const isSelectable =
                  compareMode &&
                  (run.status === "completed" || run.status === "failed");
                const isSelected = compareSelections.includes(run.id);
                return (
                  <RunRow
                    key={run.id}
                    run={run}
                    onOpen={
                      compareMode
                        ? isSelectable
                          ? () => handleToggleCompareSelection(run.id)
                          : undefined
                        : () => setDetailRunId(run.id)
                    }
                    compareMode={compareMode}
                    isSelected={isSelected}
                    isSelectable={isSelectable}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showDialog && (
        <RunEvalDialog
          rubrics={rubrics}
          initialRubricId={selectedRubricId}
          onClose={() => setShowDialog(false)}
          onCreated={handleRunCreated}
          managedEstimatePlan={managedEstimatePlan}
        />
      )}

      {detailRunId && (
        <RunDetailModal
          runId={detailRunId}
          onClose={() => setDetailRunId(null)}
        />
      )}

      {comparisonIds && (
        <RunComparisonModal
          runIdA={comparisonIds[0]}
          runIdB={comparisonIds[1]}
          onClose={() => setComparisonIds(null)}
        />
      )}
    </>
  );
}

function SplitPaneIllustration() {
  return (
    <svg
      width="72"
      height="56"
      viewBox="0 0 72 56"
      fill="none"
      aria-hidden="true"
      className="text-fg-4"
    >
      {/* Left panel */}
      <rect x="2" y="2" width="28" height="52" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="8" width="18" height="3" rx="1.5" fill="currentColor" opacity="0.4" />
      <rect x="7" y="15" width="18" height="2" rx="1" fill="currentColor" opacity="0.25" />
      <rect x="7" y="20" width="14" height="2" rx="1" fill="currentColor" opacity="0.25" />
      <rect x="7" y="25" width="16" height="2" rx="1" fill="currentColor" opacity="0.25" />
      {/* Selected row highlight */}
      <rect x="5" y="31" width="22" height="6" rx="2" fill="currentColor" opacity="0.12" />
      <rect x="7" y="33" width="14" height="2" rx="1" fill="currentColor" opacity="0.4" />
      {/* Arrow */}
      <path d="M33 28 L39 28" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M37 25.5 L39.5 28 L37 30.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Right panel */}
      <rect x="42" y="2" width="28" height="52" rx="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.5" />
      <rect x="47" y="8" width="18" height="3" rx="1.5" fill="currentColor" opacity="0.2" />
      <rect x="47" y="16" width="18" height="6" rx="2" fill="currentColor" opacity="0.08" />
      <rect x="47" y="26" width="18" height="6" rx="2" fill="currentColor" opacity="0.08" />
    </svg>
  );
}

function RunRow({
  run,
  onOpen,
  compareMode = false,
  isSelected = false,
  isSelectable = false,
}: {
  run: EvalRun;
  onOpen?: () => void;
  compareMode?: boolean;
  isSelected?: boolean;
  isSelectable?: boolean;
}) {
  const canOpen =
    !compareMode && (run.status === "completed" || run.status === "failed");
  const interactive = canOpen || isSelectable;
  return (
    <button
      type="button"
      onClick={interactive ? onOpen : undefined}
      disabled={!interactive}
      aria-disabled={!interactive}
      aria-pressed={compareMode ? isSelected : undefined}
      className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
        isSelected
          ? "border-accent bg-accent-soft"
          : "border-transparent bg-card-warm"
      } ${
        interactive
          ? "cursor-pointer hover:bg-paper-warm"
          : "pointer-events-none cursor-default opacity-60"
      }`}
    >
      {compareMode ? (
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
            isSelected
              ? "border-accent bg-accent text-fg-on-accent"
              : "border-hairline-cool bg-card"
          }`}
          aria-hidden="true"
        >
          {isSelected && (
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
              <path
                d="M1 4l3 3 5-6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      ) : (
        <StatusBadge status={run.status} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {run.description ?? <ClientDate value={run.createdAt} />}
        </p>
        {run.description && (
          <p className="mt-0.5 text-xs text-fg-3">
            <ClientDate value={run.createdAt} />
          </p>
        )}
      </div>
      {run.overallScore != null ? (
        <ScoreWithTooltip runId={run.id}>
          <span
            className={`font-mono text-sm font-bold tabular-nums ${scoreColor(run.overallScore)}`}
          >
            {Math.round(run.overallScore * 100)}%
          </span>
        </ScoreWithTooltip>
      ) : (
        <span className="shrink-0 font-mono text-sm font-medium text-fg-4">
          —
        </span>
      )}
      {canOpen && (
        <span className="flex shrink-0 text-fg-4">
          <ChevronRightIcon size={14} />
        </span>
      )}
    </button>
  );
}

// The currently in-progress run — the single dark "focus" card per view.
function ActiveRunCard({ run }: { run: EvalRun }) {
  const label = run.status === "queued" ? "Queued" : "Running";
  return (
    <div className="hero-card rounded-2xl bg-ink-soft p-5 text-white">
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <SparklesIcon size={16} className="text-accent" />
          <span className="text-[13px] font-medium text-fg-on-ink-muted">
            Now {run.status}
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-semibold text-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-soft" />
          {label}
        </span>
      </div>
      <div className="text-[17px] font-semibold tracking-[-0.01em]">
        {run.description ?? "Untitled run"}
      </div>
      <div className="mt-1 text-xs text-fg-on-ink-muted">
        Started <ClientDate value={run.createdAt} />
      </div>
      {/* Indeterminate progress — real per-row progress isn't reported yet. */}
      <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-pulse-soft rounded-full bg-accent" />
      </div>
      <div className="mt-2.5 font-mono text-[11px] text-fg-on-ink-muted">
        {run.status === "queued" ? "Waiting for a worker…" : "Scoring rows…"}
      </div>
    </div>
  );
}
