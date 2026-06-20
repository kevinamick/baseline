"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { getEvalRunComparison } from "@/app/actions/eval-runs";
import { Dialog } from "@/app/_components/dialog";
import { scoreColor } from "@/app/_components/eval-run-helpers";
import { ChevronRightIcon, XIcon } from "@/app/_components/icons";
import { ClientDate } from "@/app/_components/client-date";
import type { EvalRunComparison, EvalRunResult } from "@/types/eval-run";

interface Props {
  runIdA: string;
  runIdB: string;
  onClose: () => void;
}

export function RunComparisonModal({ runIdA, runIdB, onClose }: Props) {
  const t = useTranslations("Rubrics");
  const [comparison, setComparison] = useState<EvalRunComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());

  // `loading` starts true and the modal is mounted fresh per comparison, so the
  // fetch runs once on mount — no need to flip loading on synchronously here.
  useEffect(() => {
    let active = true;
    getEvalRunComparison(runIdA, runIdB).then((data) => {
      if (!active) return;
      setComparison(data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [runIdA, runIdB]);

  function toggleRow(i: number) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });
  }

  const rowIndexes = comparison
    ? [
        ...new Set([
          ...comparison.runA.rows.map((r) => r.rowIndex),
          ...comparison.runB.rows.map((r) => r.rowIndex),
        ]),
      ].sort((a, b) => a - b)
    : [];

  const criteriaNames = comparison
    ? [...new Set(comparison.runA.results.map((r) => r.criterionName))].sort()
    : [];

  function criterionAvg(results: EvalRunResult[], name: string): number | null {
    const matching = results.filter((r) => r.criterionName === name);
    if (matching.length === 0) return null;
    return matching.reduce((s, r) => s + r.score, 0) / matching.length;
  }

  function rowAvg(results: EvalRunResult[], rowIdx: number): number | null {
    const matching = results.filter((r) => r.rowIndex === rowIdx);
    if (matching.length === 0) return null;
    return matching.reduce((s, r) => s + r.score, 0) / matching.length;
  }

  return (
    <Dialog
      onClose={onClose}
      ariaLabelledBy="run-compare-title"
      className="max-w-5xl h-[90vh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-6 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-3">
            {t("comparison.eyebrow")}
          </span>
          <h2
            id="run-compare-title"
            className="text-lg font-semibold tracking-[-0.015em]"
          >
            {t("comparison.title")}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("comparison.close")}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-fg-2 transition-colors hover:bg-paper hover:text-ink"
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {loading ? (
          <p className="text-sm text-fg-4">{t("comparison.loading")}</p>
        ) : !comparison ? (
          <p className="text-sm text-danger-fg">{t("comparison.loadError")}</p>
        ) : (
          <>
            {/* Score summary tiles */}
            <div className="grid grid-cols-2 gap-3">
              <ScoreTile
                label={comparison.runA.description ?? t("comparison.runA")}
                date={comparison.runA.createdAt}
                score={comparison.runA.overallScore}
              />
              <ScoreTile
                label={comparison.runB.description ?? t("comparison.runB")}
                date={comparison.runB.createdAt}
                score={comparison.runB.overallScore}
              />
            </div>

            {/* Per-criterion aggregate comparison */}
            {criteriaNames.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-hairline">
                <div className="grid grid-cols-[1fr_5rem_5rem_5rem] border-b border-hairline bg-paper-warm px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                  <span>{t("comparison.criterion")}</span>
                  <span className="text-right">{t("comparison.colRunA")}</span>
                  <span className="text-right">{t("comparison.colRunB")}</span>
                  <span className="text-right">{t("comparison.delta")}</span>
                </div>
                {criteriaNames.map((name) => {
                  const a = criterionAvg(comparison.runA.results, name);
                  const b = criterionAvg(comparison.runB.results, name);
                  const delta = a != null && b != null ? b - a : null;
                  return (
                    <div
                      key={name}
                      className="grid grid-cols-[1fr_5rem_5rem_5rem] px-4 py-2.5 text-sm even:bg-paper-warm/40"
                    >
                      <span className="font-medium text-ink">{name}</span>
                      <span
                        className={`text-right font-mono text-xs font-bold tabular-nums ${
                          a != null ? scoreColor(a) : "text-fg-4"
                        }`}
                      >
                        {a != null ? a.toFixed(2) : "—"}
                      </span>
                      <span
                        className={`text-right font-mono text-xs font-bold tabular-nums ${
                          b != null ? scoreColor(b) : "text-fg-4"
                        }`}
                      >
                        {b != null ? b.toFixed(2) : "—"}
                      </span>
                      <span
                        className={`text-right font-mono text-xs font-bold tabular-nums ${
                          delta == null
                            ? "text-fg-4"
                            : delta > 0
                              ? "text-success"
                              : delta < 0
                                ? "text-danger-fg"
                                : "text-fg-3"
                        }`}
                      >
                        {delta == null
                          ? "—"
                          : (delta > 0 ? "+" : "") + delta.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Per-row breakdown */}
            {rowIndexes.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink">
                  {t("comparison.perRowBreakdown")}
                </h3>
                {rowIndexes.map((rowIdx) => {
                  const rowA = comparison.runA.rows.find(
                    (r) => r.rowIndex === rowIdx
                  );
                  const rowB = comparison.runB.rows.find(
                    (r) => r.rowIndex === rowIdx
                  );
                  const resultsRowA = comparison.runA.results.filter(
                    (r) => r.rowIndex === rowIdx
                  );
                  const resultsRowB = comparison.runB.results.filter(
                    (r) => r.rowIndex === rowIdx
                  );
                  const avgA = rowAvg(comparison.runA.results, rowIdx);
                  const avgB = rowAvg(comparison.runB.results, rowIdx);
                  const delta =
                    avgA != null && avgB != null ? avgB - avgA : null;
                  const isOpen = openRows.has(rowIdx);
                  const rowCriteria = [
                    ...new Set([
                      ...resultsRowA.map((r) => r.criterionName),
                      ...resultsRowB.map((r) => r.criterionName),
                    ]),
                  ].sort();

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
                            {t("comparison.rowLabel", { num: rowIdx + 1 })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {avgA != null && (
                            <span
                              className={`font-mono text-sm font-bold tabular-nums ${scoreColor(avgA)}`}
                            >
                              {Math.round(avgA * 100)}%
                            </span>
                          )}
                          <span className="text-fg-4 text-xs">→</span>
                          {avgB != null && (
                            <span
                              className={`font-mono text-sm font-bold tabular-nums ${scoreColor(avgB)}`}
                            >
                              {Math.round(avgB * 100)}%
                            </span>
                          )}
                          {delta != null && (
                            <span
                              className={`font-mono text-xs font-semibold tabular-nums ${
                                delta > 0
                                  ? "text-success"
                                  : delta < 0
                                    ? "text-danger-fg"
                                    : "text-fg-3"
                              }`}
                            >
                              ({delta > 0 ? "+" : ""}
                              {Math.round(delta * 100)}%)
                            </span>
                          )}
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t border-hairline bg-paper-warm">
                          {/* User input — shared if identical, side-by-side if different */}
                          <div className="border-b border-hairline px-4 py-3">
                            {rowA?.userInput === rowB?.userInput ? (
                              <div>
                                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                                  {t("comparison.userInput")}
                                </span>
                                <p className="mt-1 text-xs leading-relaxed text-fg-2">
                                  {rowA?.userInput ?? "—"}
                                </p>
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                                    {t("comparison.runAInput")}
                                  </span>
                                  <p className="mt-1 text-xs leading-relaxed text-fg-2">
                                    {rowA?.userInput ?? "—"}
                                  </p>
                                </div>
                                <div>
                                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                                    {t("comparison.runBInput")}
                                  </span>
                                  <p className="mt-1 text-xs leading-relaxed text-fg-2">
                                    {rowB?.userInput ?? "—"}
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Agent outputs — always side-by-side */}
                          <div className="grid grid-cols-2 border-b border-hairline">
                            <div className="border-r border-hairline px-4 py-3">
                              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                                {t("comparison.runAOutput")}
                              </span>
                              <p className="mt-1 text-xs leading-relaxed text-fg-2">
                                {rowA?.agentOutput ?? "—"}
                              </p>
                            </div>
                            <div className="px-4 py-3">
                              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                                {t("comparison.runBOutput")}
                              </span>
                              <p className="mt-1 text-xs leading-relaxed text-fg-2">
                                {rowB?.agentOutput ?? "—"}
                              </p>
                            </div>
                          </div>

                          {/* Per-criterion scores for this row */}
                          {rowCriteria.length > 0 && (
                            <div className="px-4 py-3">
                              <div className="mb-2 grid grid-cols-[1fr_4rem_4rem_4rem] text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                                <span>{t("comparison.criterion")}</span>
                                <span className="text-right">A</span>
                                <span className="text-right">B</span>
                                <span className="text-right">Δ</span>
                              </div>
                              {rowCriteria.map((name) => {
                                const resA = resultsRowA.find(
                                  (r) => r.criterionName === name
                                );
                                const resB = resultsRowB.find(
                                  (r) => r.criterionName === name
                                );
                                const d =
                                  resA && resB ? resB.score - resA.score : null;
                                return (
                                  <div
                                    key={name}
                                    className="grid grid-cols-[1fr_4rem_4rem_4rem] py-1.5"
                                  >
                                    <span className="text-xs font-medium text-ink">
                                      {name}
                                    </span>
                                    <span
                                      className={`text-right font-mono text-xs font-bold tabular-nums ${
                                        resA ? scoreColor(resA.score) : "text-fg-4"
                                      }`}
                                    >
                                      {resA ? resA.score.toFixed(2) : "—"}
                                    </span>
                                    <span
                                      className={`text-right font-mono text-xs font-bold tabular-nums ${
                                        resB ? scoreColor(resB.score) : "text-fg-4"
                                      }`}
                                    >
                                      {resB ? resB.score.toFixed(2) : "—"}
                                    </span>
                                    <span
                                      className={`text-right font-mono text-xs tabular-nums ${
                                        d == null
                                          ? "text-fg-4"
                                          : d > 0
                                            ? "text-success"
                                            : d < 0
                                              ? "text-danger-fg"
                                              : "text-fg-3"
                                      }`}
                                    >
                                      {d == null
                                        ? "—"
                                        : (d > 0 ? "+" : "") + d.toFixed(2)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
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
        <div className="flex gap-3 font-mono text-[11px] text-fg-3">
          <span className="truncate max-w-[180px]">{runIdA}</span>
          <span>{t("comparison.vs")}</span>
          <span className="truncate max-w-[180px]">{runIdB}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          {t("comparison.close")}
        </button>
      </div>
    </Dialog>
  );
}

function ScoreTile({
  label,
  date,
  score,
}: {
  label: string;
  date: string;
  score: number | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-card-warm px-4 py-3.5">
      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">
        {label}
      </span>
      <div className="flex items-end justify-between gap-2">
        <span
          className={`text-[1.35rem] font-semibold ${
            score != null ? scoreColor(score) : "text-fg-4"
          }`}
        >
          {score != null ? `${Math.round(score * 100)}%` : "—"}
        </span>
        <span className="pb-0.5 text-xs text-fg-4">
          <ClientDate value={date} relative />
        </span>
      </div>
    </div>
  );
}
