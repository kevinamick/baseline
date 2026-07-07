"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { getEvalRunComparison } from "@/app/actions/eval-runs";
import { Dialog } from "@/app/_components/dialog";
import { scoreColor } from "@/app/_components/eval-run-helpers";
import { ChevronRightIcon, XIcon } from "@/app/_components/icons";
import { ClientDate } from "@/app/_components/client-date";
import type {
  EvalRunComparison,
  EvalRunResult,
  EvalRunRowData,
} from "@/types/eval-run";

interface Props {
  runIdA: string;
  runIdB: string;
  onClose: () => void;
}

interface RowCriterionView {
  name: string;
  resA: EvalRunResult | null;
  resB: EvalRunResult | null;
  d: number | null;
}

interface RowView {
  rowIdx: number;
  rowA: EvalRunRowData | undefined;
  rowB: EvalRunRowData | undefined;
  avgA: number | null;
  avgB: number | null;
  delta: number | null;
  criteria: RowCriterionView[];
}

interface CriterionAggregateView {
  name: string;
  a: number | null;
  b: number | null;
  delta: number | null;
}

interface ComparisonView {
  criteriaAggregate: CriterionAggregateView[];
  rows: RowView[];
}

// Average each run's scores grouped by an arbitrary key (criterion name or row
// index) in a single pass, so the modal never re-filters the results array per
// criterion/row on every render.
function avgByKey<K>(
  results: EvalRunResult[],
  keyOf: (r: EvalRunResult) => K
): Map<K, number> {
  const acc = new Map<K, { sum: number; count: number }>();
  for (const r of results) {
    const k = keyOf(r);
    const e = acc.get(k);
    if (e) {
      e.sum += r.score;
      e.count += 1;
    } else {
      acc.set(k, { sum: r.score, count: 1 });
    }
  }
  const out = new Map<K, number>();
  for (const [k, { sum, count }] of acc) out.set(k, sum / count);
  return out;
}

function groupByRow(results: EvalRunResult[]): Map<number, EvalRunResult[]> {
  const out = new Map<number, EvalRunResult[]>();
  for (const r of results) {
    const arr = out.get(r.rowIndex);
    if (arr) arr.push(r);
    else out.set(r.rowIndex, [r]);
  }
  return out;
}

// Precompute the whole comparison render view once per fetched payload: grouped
// result Maps, per-criterion and per-row averages, and the resolved per-row
// criterion cells. Output is identical to the previous inline `.find()`/`.filter()`
// derivation but runs once (in a useMemo) instead of on every row-toggle re-render.
function buildComparisonView(
  comparison: EvalRunComparison | null
): ComparisonView {
  if (!comparison) return { criteriaAggregate: [], rows: [] };
  const { runA, runB } = comparison;

  const avgCritA = avgByKey(runA.results, (r) => r.criterionName);
  const avgCritB = avgByKey(runB.results, (r) => r.criterionName);
  const avgRowA = avgByKey(runA.results, (r) => r.rowIndex);
  const avgRowB = avgByKey(runB.results, (r) => r.rowIndex);

  // Aggregate criteria are sourced from run A's results, matching the original
  // criteriaNames derivation; run B contributes a value only where the name exists.
  const criteriaAggregate = [...avgCritA.keys()].sort().map((name) => {
    const a = avgCritA.get(name) ?? null;
    const b = avgCritB.get(name) ?? null;
    return { name, a, b, delta: a != null && b != null ? b - a : null };
  });

  const resultsAByRow = groupByRow(runA.results);
  const resultsBByRow = groupByRow(runB.results);
  const rowAByIdx = new Map(runA.rows.map((r) => [r.rowIndex, r] as const));
  const rowBByIdx = new Map(runB.rows.map((r) => [r.rowIndex, r] as const));

  const rowIndexes = [
    ...new Set([
      ...runA.rows.map((r) => r.rowIndex),
      ...runB.rows.map((r) => r.rowIndex),
    ]),
  ].sort((a, b) => a - b);

  const rows = rowIndexes.map<RowView>((rowIdx) => {
    const resultsRowA = resultsAByRow.get(rowIdx) ?? [];
    const resultsRowB = resultsBByRow.get(rowIdx) ?? [];
    const resAByName = new Map(
      resultsRowA.map((r) => [r.criterionName, r] as const)
    );
    const resBByName = new Map(
      resultsRowB.map((r) => [r.criterionName, r] as const)
    );
    const criteria = [
      ...new Set([
        ...resultsRowA.map((r) => r.criterionName),
        ...resultsRowB.map((r) => r.criterionName),
      ]),
    ]
      .sort()
      .map<RowCriterionView>((name) => {
        const resA = resAByName.get(name) ?? null;
        const resB = resBByName.get(name) ?? null;
        return {
          name,
          resA,
          resB,
          d: resA && resB ? resB.score - resA.score : null,
        };
      });
    const avgA = avgRowA.get(rowIdx) ?? null;
    const avgB = avgRowB.get(rowIdx) ?? null;
    return {
      rowIdx,
      rowA: rowAByIdx.get(rowIdx),
      rowB: rowBByIdx.get(rowIdx),
      avgA,
      avgB,
      delta: avgA != null && avgB != null ? avgB - avgA : null,
      criteria,
    };
  });

  return { criteriaAggregate, rows };
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
    getEvalRunComparison(runIdA, runIdB)
      .then((data) => {
        if (!active) return;
        setComparison(data);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
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

  // The comparison payload is immutable once fetched, but the modal re-renders on
  // every row toggle (openRows is state). Without memoization each toggle re-ran the
  // whole per-(row × criterion) `.find()`/`.filter()` resolution — O(rows × results)
  // per render. Precompute the entire view (grouped Maps, aggregates) once per
  // comparison so toggles are O(1) lookups, mirroring the dashboard feed Map fix.
  const view = useMemo(() => buildComparisonView(comparison), [comparison]);

  return (
    <Dialog
      onClose={onClose}
      ariaLabelledBy="run-compare-title"
      className="max-w-5xl h-[90dvh]"
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
          className="flex h-11 w-11 items-center justify-center rounded-full bg-paper-warm text-fg-2 transition-colors hover:bg-paper hover:text-ink sm:h-8 sm:w-8"
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
            {view.criteriaAggregate.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-hairline">
                <div className="hidden grid-cols-[1fr_5rem_5rem_5rem] border-b border-hairline bg-paper-warm px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3 sm:grid">
                  <span>{t("comparison.criterion")}</span>
                  <span className="text-right">{t("comparison.colRunA")}</span>
                  <span className="text-right">{t("comparison.colRunB")}</span>
                  <span className="text-right">{t("comparison.delta")}</span>
                </div>
                {view.criteriaAggregate.map(({ name, a, b, delta }) => {
                  return (
                    <div
                      key={name}
                      className="grid grid-cols-3 gap-x-2 gap-y-1 px-4 py-2.5 text-sm even:bg-paper-warm/40 sm:grid-cols-[1fr_5rem_5rem_5rem] sm:gap-0"
                    >
                      <span className="col-span-3 font-medium text-ink sm:col-span-1">{name}</span>
                      <CompareCell label="A" color={a != null ? scoreColor(a) : "text-fg-4"}>
                        {a != null ? a.toFixed(2) : "—"}
                      </CompareCell>
                      <CompareCell label="B" color={b != null ? scoreColor(b) : "text-fg-4"}>
                        {b != null ? b.toFixed(2) : "—"}
                      </CompareCell>
                      <CompareCell
                        label="Δ"
                        color={
                          delta == null
                            ? "text-fg-4"
                            : delta > 0
                              ? "text-success"
                              : delta < 0
                                ? "text-danger-fg"
                                : "text-fg-3"
                        }
                      >
                        {delta == null
                          ? "—"
                          : (delta > 0 ? "+" : "") + delta.toFixed(2)}
                      </CompareCell>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Per-row breakdown */}
            {view.rows.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink">
                  {t("comparison.perRowBreakdown")}
                </h3>
                {view.rows.map((row) => {
                  const { rowIdx, rowA, rowB, avgA, avgB, delta, criteria } = row;
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
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

                          {/* Agent outputs — side-by-side at sm+, stacked on mobile */}
                          <div className="grid grid-cols-1 border-b border-hairline sm:grid-cols-2">
                            <div className="border-b border-hairline px-4 py-3 sm:border-b-0 sm:border-r">
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
                          {criteria.length > 0 && (
                            <div className="px-4 py-3">
                              <div className="mb-2 hidden grid-cols-[1fr_4rem_4rem_4rem] text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3 sm:grid">
                                <span>{t("comparison.criterion")}</span>
                                <span className="text-right">A</span>
                                <span className="text-right">B</span>
                                <span className="text-right">Δ</span>
                              </div>
                              {criteria.map(({ name, resA, resB, d }) => {
                                return (
                                  <div
                                    key={name}
                                    className="grid grid-cols-3 gap-x-2 gap-y-0.5 py-1.5 sm:grid-cols-[1fr_4rem_4rem_4rem] sm:gap-0"
                                  >
                                    <span className="col-span-3 text-xs font-medium text-ink sm:col-span-1">
                                      {name}
                                    </span>
                                    <CompareCell label="A" color={resA ? scoreColor(resA.score) : "text-fg-4"}>
                                      {resA ? resA.score.toFixed(2) : "—"}
                                    </CompareCell>
                                    <CompareCell label="B" color={resB ? scoreColor(resB.score) : "text-fg-4"}>
                                      {resB ? resB.score.toFixed(2) : "—"}
                                    </CompareCell>
                                    <CompareCell
                                      label="Δ"
                                      color={
                                        d == null
                                          ? "text-fg-4"
                                          : d > 0
                                            ? "text-success"
                                            : d < 0
                                              ? "text-danger-fg"
                                              : "text-fg-3"
                                      }
                                    >
                                      {d == null
                                        ? "—"
                                        : (d > 0 ? "+" : "") + d.toFixed(2)}
                                    </CompareCell>
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
        <div className="hidden gap-3 font-mono text-[11px] text-fg-3 sm:flex">
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

// A score cell in the A/B/Δ comparison grids. On mobile the column headers are
// hidden (the grid stacks the criterion name onto its own line and drops the
// three scores below), so each cell carries its own short inline label; at sm+
// it's just the right-aligned number under the table header.
function CompareCell({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-baseline justify-between gap-1 sm:block sm:text-right">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-3 sm:hidden">
        {label}
      </span>
      <span className={`font-mono text-xs font-bold tabular-nums ${color}`}>
        {children}
      </span>
    </span>
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
