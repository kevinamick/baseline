"use client";

import { useState } from "react";
import { getRunCriteriaBreakdown } from "@/app/actions/eval-runs";
import { scoreColor } from "@/app/_components/eval-run-helpers";

export interface CriterionBreakdown {
  name: string;
  score: number; // 0–1
}

interface Props {
  /** Pre-loaded criteria — shown immediately on hover without a round-trip. */
  criteria?: CriterionBreakdown[];
  /** Run ID for lazy-fetching criteria when they aren't pre-loaded. */
  runId?: string;
  children: React.ReactNode;
}

/**
 * Wraps a score display element and reveals a criteria breakdown tooltip on hover.
 * Accepts either pre-loaded criteria (shown instantly) or a runId for lazy fetch.
 */
export function ScoreWithTooltip({ criteria: initialCriteria, runId, children }: Props) {
  const [open, setOpen] = useState(false);
  const [criteria, setCriteria] = useState<CriterionBreakdown[] | null>(
    initialCriteria ?? null,
  );
  const [loading, setLoading] = useState(false);

  async function handleMouseEnter() {
    setOpen(true);
    if (criteria === null && runId && !loading) {
      setLoading(true);
      const breakdown = await getRunCriteriaBreakdown(runId);
      setCriteria(breakdown);
      setLoading(false);
    }
  }

  const hasCriteria = criteria !== null && criteria.length > 0;
  const showTooltip = open && (hasCriteria || loading);

  return (
    <div
      className="relative shrink-0"
      data-testid="score-tooltip-trigger"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {showTooltip && (
        <div
          role="tooltip"
          className="absolute bottom-full right-0 z-50 mb-1.5 min-w-[160px] rounded-lg border border-hairline-cool bg-card px-3 py-2 shadow-lg"
        >
          {loading ? (
            <p className="whitespace-nowrap text-xs text-fg-3">Loading…</p>
          ) : (
            <div className="flex flex-col gap-1">
              {criteria?.map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs text-fg-2">{c.name}</span>
                  <span
                    className={`font-mono text-xs font-bold tabular-nums ${scoreColor(c.score)}`}
                  >
                    {Math.round(c.score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
