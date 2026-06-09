"use client";

import { useEffect, useRef, useState } from "react";
import { getEvalRuns } from "@/app/actions/eval-runs";
import { track } from "@/lib/analytics/client";
import { RunEvalDialog } from "./run-eval-dialog";
import { RunDetailModal } from "./run-detail-modal";
import { ClientDate } from "@/app/_components/client-date";
import { scoreColor, StatusBadge } from "@/app/_components/eval-run-helpers";
import {
  ChevronRightIcon,
  PlayIcon,
  SparklesIcon,
} from "@/app/_components/icons";
import type { EvalRun } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";

const POLL_INTERVAL_MS = 5000;

interface Props {
  selectedRubricId: string | null;
  rubrics: RubricSummary[];
  canWrite: boolean;
}

export function RunsPanel({ selectedRubricId, rubrics, canWrite }: Props) {
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

  // The newest in-progress run gets the dark "focus" card treatment.
  const activeRun = runs.find(
    (r) => r.status === "running" || r.status === "queued"
  );
  const otherRuns = runs.filter((r) => r !== activeRun);

  return (
    <>
      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
        {/* Header */}
        <div className="flex min-h-[60px] shrink-0 items-center justify-between border-b border-hairline px-5 py-4">
          <h2 className="text-base font-semibold tracking-[-0.01em]">
            {selectedRubricId ? (
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-fg-3">Eval runs</span>
                <span className="text-fg-3">/</span>
                <span>{rubrics.find((r) => r.id === selectedRubricId)?.name}</span>
              </span>
            ) : (
              "Eval runs"
            )}
          </h2>
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-1.5">
          {!selectedRubricId ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-fg-3">
                Select a rubric to view its runs
              </p>
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
              {activeRun && <ActiveRunCard run={activeRun} />}
              {otherRuns.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onOpen={() => setDetailRunId(run.id)}
                />
              ))}
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

function RunRow({ run, onOpen }: { run: EvalRun; onOpen: () => void }) {
  const canOpen = run.status === "completed" || run.status === "failed";
  return (
    <button
      type="button"
      onClick={canOpen ? onOpen : undefined}
      disabled={!canOpen}
      aria-disabled={!canOpen}
      className={`flex w-full items-center gap-3 rounded-lg border border-transparent bg-card-warm px-4 py-3 text-left transition-colors ${
        canOpen
          ? "cursor-pointer hover:bg-paper-warm"
          : "pointer-events-none cursor-default opacity-80"
      }`}
    >
      <StatusBadge status={run.status} />
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
        <span
          className={`shrink-0 font-mono text-sm font-bold tabular-nums ${scoreColor(run.overallScore)}`}
        >
          {Math.round(run.overallScore * 100)}%
        </span>
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
          <span className="text-[13px] font-medium text-fg-4">
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
      <div className="mt-1 text-xs text-fg-4">
        Started <ClientDate value={run.createdAt} />
      </div>
      {/* Indeterminate progress — real per-row progress isn't reported yet. */}
      <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-pulse-soft rounded-full bg-accent" />
      </div>
      <div className="mt-2.5 font-mono text-[11px] text-fg-4">
        {run.status === "queued" ? "Waiting for a worker…" : "Scoring rows…"}
      </div>
    </div>
  );
}
