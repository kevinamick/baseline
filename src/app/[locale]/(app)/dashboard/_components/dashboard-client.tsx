"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ArrowRightIcon, PlayIcon, SparklesIcon } from "@/app/_components/icons";
import { ScoreWithTooltip, type CriterionBreakdown } from "@/app/_components/score-with-tooltip";
import { RunEvalDialog } from "@/app/[locale]/(app)/rubrics/_components/run-eval-dialog";
import { track } from "@/lib/analytics/client";
import { ScoreTimeChart, Sparkline, StatusMix } from "./charts";
import {
  DAY_MS,
  PASSING_THRESHOLD,
  RANGE_OPTIONS,
  fmtDay,
  fmtDayYear,
  isScored,
  pct,
  scoreClass,
  scoreHexDark,
  type DashRubric,
  type DashRun,
  type DashboardData,
} from "../_lib/dashboard-data";
import {
  cardsWindowDays,
  domainFor,
  spanCrossesYear,
  parseRangeParam,
  serializeRangeParam,
  type RangeState,
} from "../_lib/range";
import type { EvalRunStatus } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";

interface RubricStat {
  rubric: DashRubric;
  latest: number | null; // Latest Score: newest scored run ever, however old
  delta: number | null; // latest vs the scored run before it (ever)
  runCount: number; // runs inside the cards' window
  latestRun: DashRun | null; // newest run ever, any status
  spark: DashRun[]; // completed, scored runs inside the window, ascending
  recent: DashRun[]; // last 4 scored runs ever, ascending
}

const EMPTY_RUNS: DashRun[] = [];
const EMPTY_CRITERIA: CriterionBreakdown[] = [];

// Locale-aware "time ago" ("5 min. ago" in en, "hace 5 min" in es,
// "il y a 5 min" in fr). Style is "short", not "narrow" — French narrow
// renders the minus notation ("-5 min"), not an "ago" phrase. Sub-minute
// collapses to a translated "just now" since RelativeTimeFormat has no
// neat token for it.
function relTime(time: number, now: number, locale: string, justNow: string): string {
  const m = Math.round((now - time) / 60000);
  if (m < 1) return justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  return rtf.format(-Math.round(h / 24), "day");
}

export function DashboardClient({
  data,
  canWrite,
}: {
  data: DashboardData;
  canWrite: boolean;
}) {
  const { teamName, rubrics, runs, today } = data;
  const t = useTranslations("Dashboard");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Chart state initializes from the URL so a shared link (or a refresh)
  // reproduces the view. Unknown ids and garbage params fall back to defaults.
  const [range, setRange] = useState<RangeState>(() => parseRangeParam(searchParams.get("range")));
  const [focusedId, setFocusedId] = useState<string | null>(() => {
    const p = searchParams.get("focus");
    return p && rubrics.some((r) => r.id === p) ? p : (rubrics[0]?.id ?? null);
  });
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const p = searchParams.get("hidden");
    return new Set((p ? p.split(",") : []).filter((id) => rubrics.some((r) => r.id === id)));
  });
  const [runDialogRubricId, setRunDialogRubricId] = useState<string | null>(null);

  // Mirror chart state back into the URL. replaceState (not router.replace)
  // keeps this a shallow update — no server re-render per focus click — and
  // still syncs useSearchParams. Defaults are omitted to keep URLs clean.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const apply = (key: string, value: string | null) => {
      if (value == null) params.delete(key);
      else params.set(key, value);
    };
    apply("range", range.mode === "auto" ? null : serializeRangeParam(range));
    apply("focus", focusedId && focusedId !== rubrics[0]?.id ? focusedId : null);
    apply("hidden", hidden.size ? [...hidden].join(",") : null);
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [range, focusedId, hidden, rubrics]);

  // The run-eval dialog needs the team's rubrics in RubricSummary shape for its
  // rubric picker. created_at isn't shown in the dialog, but the type wants it.
  const rubricSummaries: RubricSummary[] = useMemo(
    () =>
      rubrics.map((r) => ({
        id: r.id,
        name: r.name,
        evaluation_mode: r.mode,
        created_at: r.createdAt,
        criteriaCount: r.criteria.length,
      })),
    [rubrics]
  );

  function openRunDialog(rubricId: string) {
    if (!canWrite) return; // Readonly Members can't create runs.
    track({ name: "eval_run.dialog_opened" });
    setRunDialogRubricId(rubricId);
  }

  // The cards keep a stable window (pinned preset, else 30d); only the chart
  // follows Auto/Custom. See range.ts.
  const cardsDays = cardsWindowDays(range);
  const t0 = today - cardsDays * DAY_MS;

  const runsByRubric = useMemo(() => {
    const m = new Map<string, DashRun[]>();
    runs.forEach((r) => {
      const arr = m.get(r.rubricId) ?? [];
      arr.push(r);
      m.set(r.rubricId, arr);
    });
    return m;
  }, [runs]);

  const focusedRuns = (focusedId && runsByRubric.get(focusedId)) || EMPTY_RUNS;
  const chartDomain = useMemo(
    () => domainFor(range, focusedRuns, today),
    [range, focusedRuns, today]
  );

  // Localized chart-span caption, e.g. "Mar 12 – Jun 10 · auto". Year suffixes
  // appear only when the domain crosses a calendar year.
  const spanLabel = useMemo(() => {
    const crosses = spanCrossesYear(chartDomain);
    const day = (ms: number) => (crosses ? fmtDayYear(ms, locale) : fmtDay(ms, locale));
    const mode =
      range.mode === "preset"
        ? t("range.presetDays", { days: range.days })
        : t(range.mode === "auto" ? "range.spanAuto" : "range.spanCustom");
    return `${day(chartDomain.t0)} – ${day(chartDomain.t1)} · ${mode}`;
  }, [chartDomain, range, locale, t]);

  const visible = useMemo(() => {
    const s = new Set(rubrics.map((r) => r.id));
    hidden.forEach((id) => s.delete(id));
    return s;
  }, [hidden, rubrics]);

  // ---- per-rubric stats ---------------------------------------------------
  // Latest Score / delta come from the rubric's whole Run History (the server
  // guarantees the latest scored run is fetched); activity (runCount, spark)
  // stays scoped to the cards' window so dormant rubrics can't vanish but the
  // window still means something.
  const stats: RubricStat[] = useMemo(
    () =>
      rubrics.map((r) => {
        const all = runsByRubric.get(r.id) ?? []; // ascending by t
        const inRange = all.filter((x) => x.t >= t0 && x.t <= today);
        const completed = inRange.filter(isScored);
        const scoredAll = all.filter(isScored);
        const latest = scoredAll[scoredAll.length - 1] ?? null;
        const prev = scoredAll[scoredAll.length - 2] ?? null;
        return {
          rubric: r,
          latest: latest ? latest.score : null,
          delta: latest && prev ? (latest.score as number) - (prev.score as number) : null,
          runCount: inRange.length,
          latestRun: all[all.length - 1] ?? null,
          spark: completed,
          recent: scoredAll.slice(-4),
        };
      }),
    [rubrics, runsByRubric, t0, today]
  );

  const statById = useMemo(
    () => Object.fromEntries(stats.map((s) => [s.rubric.id, s])),
    [stats]
  );
  const focused = (focusedId && statById[focusedId]) || stats[0] || null;

  // ---- team KPIs ---------------------------------------------------------
  // State KPIs (avg score, passing) read each rubric's Latest Score (ever);
  // activity KPIs (run counts, status mix) stay scoped to the window. The
  // period delta compares against the window's first scored run per rubric —
  // rubrics with no window activity contribute their Latest Score to both
  // sides, i.e. zero drift.
  const kpi = useMemo(() => {
    const withData = stats.filter((s) => s.latest != null);
    const avgNow = withData.reduce((a, s) => a + (s.latest as number), 0) / (withData.length || 1);
    const avgThen =
      stats.reduce((a, s) => a + (s.spark[0] ? (s.spark[0].score as number) : s.latest || 0), 0) /
      (withData.length || 1);
    const passing = withData.filter((s) => (s.latest as number) >= PASSING_THRESHOLD).length;
    let total = 0,
      failed = 0,
      running = 0,
      queued = 0,
      skipped = 0,
      completed = 0;
    runs.forEach((x) => {
      if (x.t < t0 || x.t > today) return;
      total++;
      if (x.status === "failed") failed++;
      else if (x.status === "running") running++;
      else if (x.status === "queued") queued++;
      else if (x.status === "skipped") skipped++;
      else completed++;
    });
    return {
      avgNow,
      periodDelta: avgNow - avgThen,
      passing,
      totalRubrics: rubrics.length,
      total,
      failed,
      statusMix: { completed, running, queued, failed, skipped },
    };
  }, [stats, runs, rubrics, t0, today]);

  // ---- recent runs feed --------------------------------------------------
  // A run carries only its rubricId, so the feed resolves names via a
  // precomputed id→name map; doing rubrics.find() per run made this memo
  // O(runs × rubrics) on every recompute (range change / poll update).
  const rubricNameById = useMemo(
    () => new Map(rubrics.map((r) => [r.id, r.name])),
    [rubrics]
  );

  // Leaderboard score tooltips show each rubric's per-criterion breakdown. The
  // filter+map only depends on the (immutable) rubric criteria, so it's keyed on
  // [rubrics] — otherwise it re-ran for every leaderboard row on every poll
  // update and every focus click (focusedId is component state).
  const tooltipCriteriaById = useMemo(
    () =>
      new Map<string, CriterionBreakdown[]>(
        rubrics.map((r) => [
          r.id,
          r.criteria
            .filter((c) => c.score !== null)
            .map((c) => ({ name: c.name, score: c.score as number })),
        ])
      ),
    [rubrics]
  );
  const feed = useMemo(() => {
    const items = runs
      .filter((x) => x.t >= t0 && x.t <= today)
      .map((x) => ({ ...x, rubricName: rubricNameById.get(x.rubricId) ?? "" }))
      .sort((a, b) => b.t - a.t);
    return items.slice(0, 8);
  }, [runs, rubricNameById, t0, today]);

  const sortedLb = useMemo(
    () =>
      stats
        .filter((s) => s.latest != null)
        .sort((a, b) => (b.latest as number) - (a.latest as number)),
    [stats]
  );

  function toggleHidden(id: string) {
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  if (rubrics.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1360px] px-6 pb-6">
        <Header teamName={teamName} rubricCount={0} runCount={0} range={range} onRange={setRange} />
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-hairline-cool bg-card px-6 py-20 text-center shadow-card">
          <p className="text-base font-semibold text-ink">{t("empty.title")}</p>
          <p className="max-w-sm text-sm text-fg-3">{t("empty.body")}</p>
          <Link
            href="/rubrics"
            className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-fg-on-accent transition-colors hover:bg-accent-hover"
          >
            {t("empty.cta")}
            <ArrowRightIcon size={14} />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1360px] px-6 pb-6">
      <Header
        teamName={teamName}
        rubricCount={rubrics.length}
        runCount={kpi.total}
        range={range}
        onRange={setRange}
      />

      {/* KPI ROW */}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label={t("kpi.avgScore")} pill={<Pill className="bg-accent text-fg-on-accent">{t("kpi.live")}</Pill>}>
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {pct(kpi.avgNow)}%
          </span>
          <Delta value={kpi.periodDelta} />
        </KpiCard>

        <KpiCard label={t("kpi.passing")} meta={t("kpi.passingMeta", { pct: pct(PASSING_THRESHOLD) })}>
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {kpi.passing}
          </span>
          <span className="font-mono text-base font-semibold text-fg-3">/ {kpi.totalRubrics}</span>
        </KpiCard>

        <KpiCard label={t("kpi.runs")} meta={t("kpi.runsMeta", { days: cardsDays })}>
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {kpi.total}
          </span>
        </KpiCard>

        <KpiCard
          label={t("kpi.failed")}
          // State-aware: the warning chip only when there is something to look at;
          // a clean window gets a calm confirmation instead of a standing alarm.
          pill={
            kpi.failed > 0 ? (
              <Pill className="bg-danger-bg font-semibold text-danger-fg">{t("kpi.attention")}</Pill>
            ) : (
              <Pill className="border border-hairline-cool bg-card font-semibold text-fg-3">{t("kpi.allClear")}</Pill>
            )
          }
        >
          <span
            className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums"
            style={{ color: kpi.failed ? "var(--score-low)" : "var(--ink)" }}
          >
            {kpi.failed}
          </span>
        </KpiCard>
      </div>

      {/* MAIN GRID: chart + focus card */}
      <div className="mb-4 grid gap-4 lg:grid-cols-[1.95fr_1fr]">
        <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
          <div className="flex min-h-[60px] flex-col items-start gap-3 border-b border-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">{t("chart.title")}</h2>
              <p className="mt-0.5 text-xs text-fg-3">{t("chart.subtitle")}</p>
              <p className="mt-1 font-mono text-[11px] text-fg-3" data-testid="chart-span">
                {spanLabel}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {rubrics.map((r) => {
                const off = hidden.has(r.id);
                const isFocus = r.id === focusedId;
                // Two separate controls so focus and visibility are each
                // independently keyboard- and screen-reader-operable. The swatch
                // toggles chart visibility; the name focuses the series.
                return (
                  <div
                    key={r.id}
                    role="group"
                    aria-label={r.name}
                    className={`inline-flex items-center gap-2 rounded-full border py-1.5 pl-2.5 pr-3.5 text-xs font-medium transition-colors ${
                      isFocus
                        ? "border-accent bg-accent-soft font-semibold text-ink"
                        : "border-hairline-cool bg-card text-fg-2"
                    } ${off ? "opacity-40" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleHidden(r.id)}
                      aria-pressed={!off}
                      aria-label={off ? t("chart.show", { name: r.name }) : t("chart.hide", { name: r.name })}
                      title={off ? t("chart.showShort") : t("chart.hideShort")}
                      className="flex shrink-0 items-center rounded-full p-0.5 -m-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
                    >
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 rounded-full"
                        style={{
                          background: isFocus ? "var(--ink)" : r.tone,
                          boxShadow: isFocus ? "0 0 0 2px var(--ink) inset" : undefined,
                        }}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFocusedId(r.id)}
                      aria-pressed={isFocus}
                      aria-label={t("chart.focus", { name: r.name })}
                      title={t("chart.focusTitle")}
                      className="-ml-0.5 rounded-full px-0.5 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
                    >
                      {r.name}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex-1 px-5 pb-5 pt-4">
            <ScoreTimeChart
              rubrics={rubrics}
              runs={runs}
              domain={chartDomain}
              visible={visible}
              focusedId={focusedId && visible.has(focusedId) ? focusedId : null}
              onSelect={setFocusedId}
              onBrush={(b0, b1) => setRange({ mode: "custom", t0: b0, t1: b1 })}
              onResetRange={() => setRange({ mode: "auto" })}
            />
          </div>
        </section>

        {/* FOCUS DARK CARD */}
        <FocusCard
          focused={focused}
          today={today}
          canWrite={canWrite}
          onRunEval={() => focused && openRunDialog(focused.rubric.id)}
        />
      </div>

      {/* LOWER GRID: leaderboard + side */}
      <div className="grid items-start gap-4 lg:grid-cols-[1.95fr_1fr]">
        <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
          <div className="flex min-h-[60px] items-center justify-between border-b border-hairline px-5 py-4">
            <div>
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">{t("leaderboard.title")}</h2>
              <p className="mt-0.5 text-xs text-fg-3">{t("leaderboard.subtitle")}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 p-3">
            {sortedLb.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-fg-3">{t("leaderboard.empty")}</p>
            )}
            {sortedLb.map((s, i) => {
              const isFocus = s.rubric.id === focusedId;
              return (
                <button
                  key={s.rubric.id}
                  onClick={() => setFocusedId(s.rubric.id)}
                  className={`grid w-full grid-cols-[22px_1fr_auto] items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors sm:grid-cols-[22px_1fr_auto_auto_auto] sm:gap-4 ${
                    isFocus
                      ? "border-accent bg-accent-soft"
                      : "border-transparent bg-card-warm hover:bg-paper-warm"
                  }`}
                >
                  <span
                    className={`text-center font-mono text-[13px] font-semibold ${
                      isFocus ? "text-accent-ink" : "text-fg-4"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{s.rubric.name}</div>
                    <div className={`mt-0.5 text-[11.5px] ${isFocus ? "text-accent-ink" : "text-fg-2"}`}>
                      <span>{t(`mode.${s.rubric.mode}`)}</span> · {t("leaderboard.runsCount", { count: s.runCount })}
                      {s.runCount === 0 && s.latestRun && (
                        <> · {t("focus.lastRun", { time: relTime(s.latestRun.t, today, locale, t("relJustNow")) })}</>
                      )}
                    </div>
                  </div>
                  {/* Sparkline + delta are supporting detail — dropped below sm
                      so the rubric name keeps room (the row goes to 3 columns). */}
                  <div className="hidden sm:block">
                    <Sparkline series={s.spark} color={isFocus ? "var(--ink)" : s.rubric.tone} />
                  </div>
                  <div className="hidden sm:block">
                    <Delta value={s.delta} width />
                  </div>
                  <ScoreWithTooltip
                    criteria={tooltipCriteriaById.get(s.rubric.id) ?? EMPTY_CRITERIA}
                  >
                    <span className={`block w-[46px] text-right font-mono text-[17px] font-bold tabular-nums ${scoreClass(s.latest as number)}`}>
                      {pct(s.latest as number)}%
                    </span>
                  </ScoreWithTooltip>
                </button>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
            <div className="flex min-h-[60px] items-center justify-between border-b border-hairline px-5 py-4">
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">{t("runStatus.title")}</h2>
              <span className="font-mono text-xs text-fg-3">{t("runStatus.total", { count: kpi.total })}</span>
            </div>
            <div className="px-5 py-5">
              <StatusMix counts={kpi.statusMix} />
            </div>
          </section>

          <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
            <div className="flex min-h-[60px] items-center justify-between border-b border-hairline px-5 py-4">
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">{t("recent.title")}</h2>
            </div>
            <div className="px-5 pb-2 pt-1.5">
              <div className="flex flex-col">
                {feed.length === 0 && (
                  <p className="py-6 text-center text-sm text-fg-3">{t("recent.empty")}</p>
                )}
                {feed.map((x) => (
                  <div
                    key={x.id}
                    className="flex items-center gap-3 border-b border-hairline py-[11px] last:border-b-0"
                  >
                    <FeedStatusBadge status={x.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">{x.rubricName}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-3">
                        <span className="font-mono">#{x.runNo}</span>
                        <span className="text-fg-4">·</span>
                        <span>{relTime(x.t, today, locale, t("relJustNow"))}</span>
                      </div>
                    </div>
                    {x.score != null ? (
                      <ScoreWithTooltip runId={x.id}>
                        <span className={`font-mono text-sm font-bold tabular-nums ${scoreClass(x.score)}`}>
                          {pct(x.score)}%
                        </span>
                      </ScoreWithTooltip>
                    ) : (
                      <span className="text-sm font-medium text-fg-3">—</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>

      {runDialogRubricId && (
        <RunEvalDialog
          rubrics={rubricSummaries}
          initialRubricId={runDialogRubricId}
          onClose={() => setRunDialogRubricId(null)}
          onCreated={() => router.refresh()}
        />
      )}
    </div>
  );
}

// ---- header --------------------------------------------------------------

function Header({
  teamName,
  rubricCount,
  runCount,
  range,
  onRange,
}: {
  teamName: string;
  rubricCount: number;
  runCount: number;
  range: RangeState;
  onRange: (s: RangeState) => void;
}) {
  const t = useTranslations("Dashboard");
  const chipClass = (active: boolean) =>
    `rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
      active ? "bg-ink text-fg-on-ink" : "text-fg-2 hover:text-ink"
    }`;
  return (
    <header className="flex flex-col items-start gap-3 pb-5 pt-2 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div>
        <h1 className="sr-only">{t("srTitle")}</h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
          <span className="font-semibold text-ink">{teamName}</span>
          <span className="text-fg-4">·</span>
          <span>{t("rubricsCount", { count: rubricCount })}</span>
          <span className="text-fg-4">·</span>
          <span className="font-mono">{runCount}</span>
          <span>{t("runsInWindow")}</span>
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        {/* Auto fits the chart to the focused rubric's recent runs; a preset
            pins the chart AND windows the cards. A chart brush (custom mode)
            leaves no chip active. */}
        <div className="inline-flex gap-0.5 rounded-full border border-hairline-cool bg-card p-1">
          <button
            onClick={() => onRange({ mode: "auto" })}
            className={chipClass(range.mode === "auto")}
            title={t("range.autoTitle")}
          >
            {t("range.auto")}
          </button>
          {RANGE_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => onRange({ mode: "preset", days: d })}
              className={chipClass(range.mode === "preset" && range.days === d)}
            >
              {t("range.presetDays", { days: d })}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

// ---- focus card ----------------------------------------------------------

function FocusCard({
  focused,
  today,
  canWrite,
  onRunEval,
}: {
  focused: RubricStat | null;
  today: number;
  canWrite: boolean;
  onRunEval: () => void;
}) {
  const t = useTranslations("Dashboard");
  const locale = useLocale();
  if (!focused) return null;
  const { rubric } = focused;
  return (
    <section className="hero-card flex flex-col overflow-hidden rounded-2xl bg-ink-soft text-white">
      <div className="flex min-h-[60px] items-center justify-between border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="text-accent">
            <SparklesIcon size={16} />
          </span>
          <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-white">{t("focus.title")}</h2>
        </div>
        <FocusStatusBadge run={focused.latestRun} />
      </div>
      <div className="flex flex-1 flex-col gap-[18px] px-5 py-5">
        <div>
          <div className="text-sm font-semibold text-white">{rubric.name}</div>
          <div className="mt-0.5 text-xs text-fg-on-ink-muted">
            <span>{t(`mode.${rubric.mode}`)}</span> · {t("focus.runsInWindow", { count: focused.runCount })}
            {focused.runCount === 0 && focused.latestRun && (
              <> · {t("focus.lastRun", { time: relTime(focused.latestRun.t, today, locale, t("relJustNow")) })}</>
            )}
          </div>
        </div>

        <div className="flex items-end gap-3.5">
          <span className="font-mono text-[64px] font-bold leading-[0.95] tracking-[-0.03em] tabular-nums text-white">
            {focused.latest != null ? `${pct(focused.latest)}%` : "—"}
          </span>
          <div className="pb-2">
            <Delta value={focused.delta} light />
            <div className="mt-0.5 text-[11px] text-fg-on-ink-muted">{t("focus.vsPrevious")}</div>
          </div>
        </div>

        <div className="flex flex-col gap-[11px]">
          {rubric.criteria.map((c) => (
            <div key={c.name} className="flex flex-col gap-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-fg-on-ink-muted">
                  {c.name}
                  <span className="ml-[7px] font-mono text-fg-on-ink-muted">
                    {t("focus.weight", { weight: c.weight.toFixed(2) })}
                  </span>
                </span>
                <span
                  className="font-mono font-bold"
                  style={{ color: c.score != null ? scoreHexDark(c.score) : "#9ba3b3" }}
                >
                  {c.score != null ? c.score.toFixed(2) : "—"}
                </span>
              </div>
              <div className="h-[7px] overflow-hidden rounded-full bg-white/10">
                {c.score != null && (
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${c.score * 100}%`,
                      background: c.score >= 0.8 ? "#34D399" : c.score >= 0.5 ? "#FBBF24" : "#F87171",
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-on-ink-muted">{t("focus.recentRuns")}</div>
          {[...focused.recent].reverse().map((run) => (
            <div key={run.id} className="flex items-center justify-between text-xs">
              <span className="font-mono text-fg-on-ink-muted">
                #{run.runNo} · {fmtDay(run.t, locale)}
              </span>
              <span className="font-mono font-bold" style={{ color: scoreHexDark(run.score as number) }}>
                {pct(run.score as number)}%
              </span>
            </div>
          ))}
          {focused.recent.length === 0 && (
            <div className="text-xs text-fg-on-ink-muted">{t("focus.noScored")}</div>
          )}
        </div>

        <div className="mt-auto flex gap-2">
          {canWrite && (
            <button
              type="button"
              onClick={onRunEval}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-accent px-[18px] py-2.5 text-[13px] font-semibold text-fg-on-accent transition-colors hover:bg-accent-hover"
            >
              <PlayIcon size={13} />
              {t("focus.runEval")}
            </button>
          )}
          <Link
            href="/rubrics"
            className={`flex items-center justify-center gap-1.5 rounded-full bg-white/10 px-[18px] py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-white/[0.16] ${
              canWrite ? "" : "flex-1"
            }`}
          >
            {t("focus.viewRuns")}
          </Link>
        </div>
      </div>
    </section>
  );
}

// ---- small shared bits ---------------------------------------------------

function KpiCard({
  label,
  pill,
  meta,
  children,
}: {
  label: string;
  pill?: React.ReactNode;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline-cool bg-card px-5 py-4 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
        {pill}
        {meta && <span className="text-[11px] text-fg-3">{meta}</span>}
      </div>
      <div className="flex items-baseline gap-2.5">{children}</div>
    </div>
  );
}

function Pill({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-3 py-1 font-mono text-xs font-bold ${className}`}
    >
      {children}
    </span>
  );
}

function Delta({
  value,
  light = false,
  width = false,
}: {
  value: number | null;
  light?: boolean;
  width?: boolean;
}) {
  if (value == null || Math.abs(value) < 0.005) {
    return (
      <span
        className={`inline-flex items-center justify-end font-mono text-xs font-semibold ${
          light ? "text-fg-on-ink-muted" : "text-fg-4"
        } ${width ? "w-[52px]" : ""}`}
      >
        —
      </span>
    );
  }
  const up = value > 0;
  const color = light
    ? up
      ? "text-emerald-400"
      : "text-red-400"
    : up
      ? "text-success-fg"
      : "text-danger-fg";
  return (
    <span
      className={`inline-flex items-center justify-end gap-0.5 font-mono font-semibold ${color} ${
        light ? "text-[13px]" : "text-xs"
      } ${width ? "w-[52px]" : ""}`}
    >
      <svg
        width={light ? 13 : 11}
        height={light ? 13 : 11}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {up ? <path d="m5 12 7-7 7 7M12 19V5" /> : <path d="m19 12-7 7-7-7M12 5v14" />}
      </svg>
      {Math.abs(Math.round(value * 100))}
    </span>
  );
}

function FocusStatusBadge({ run }: { run: DashRun | null }) {
  const t = useTranslations("Dashboard");
  if (!run) return null;
  if (run.status === "running" || run.status === "queued") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-blue-400"
      >
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-blue-400" />
        {run.status === "queued" ? t("status.queued") : t("status.running")}
      </span>
    );
  }
  if (run.status === "failed") {
    return (
      <span
        className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-red-400"
        style={{ background: "rgba(220,38,38,0.16)" }}
      >
        {t("status.failed")}
      </span>
    );
  }
  if (run.status === "skipped") {
    return (
      <span
        className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-fg-on-ink-muted"
        style={{ background: "rgba(161,161,170,0.16)" }}
      >
        {t("status.skipped")}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-emerald-400"
      style={{ background: "rgba(52,211,153,0.16)" }}
    >
      {t("status.completed")}
    </span>
  );
}

function FeedStatusBadge({ status }: { status: EvalRunStatus }) {
  const t = useTranslations("Dashboard");
  const map: Record<EvalRunStatus, { label: string; className: string }> = {
    queued: { label: t("status.queued"), className: "bg-card-warm text-fg-2" },
    running: { label: t("status.running"), className: "bg-info-bg text-info-fg" },
    completed: { label: t("status.done"), className: "bg-success-bg text-success-fg" },
    failed: { label: t("status.failed"), className: "bg-danger-bg text-danger-fg" },
    skipped: { label: t("status.skipped"), className: "bg-card-warm text-fg-3" },
  };
  const { label, className } = map[status];
  return (
    <span
      className={`inline-flex min-w-[62px] items-center justify-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold ${className}`}
    >
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-info" />}
      {label}
    </span>
  );
}
