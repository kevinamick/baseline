"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, PlayIcon, SparklesIcon } from "@/app/_components/icons";
import { RunEvalDialog } from "@/app/rubrics/_components/run-eval-dialog";
import { track } from "@/lib/analytics/client";
import { ScoreTimeChart, Sparkline, StatusMix } from "./charts";
import {
  DAY_MS,
  PASSING_THRESHOLD,
  RANGE_OPTIONS,
  fmtDay,
  pct,
  relTime,
  scoreClass,
  scoreHexDark,
  type DashRubric,
  type DashRun,
  type DashboardData,
  type RangeDays,
} from "../_lib/dashboard-data";
import type { EvalRunStatus } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";

interface RubricStat {
  rubric: DashRubric;
  latest: number | null;
  delta: number | null;
  periodDelta: number | null;
  runCount: number;
  latestRun: DashRun | null;
  spark: DashRun[]; // completed, scored runs ascending
}

export function DashboardClient({
  data,
  canWrite,
}: {
  data: DashboardData;
  canWrite: boolean;
}) {
  const { teamName, rubrics, runs, today } = data;
  const router = useRouter();

  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [focusedId, setFocusedId] = useState<string | null>(rubrics[0]?.id ?? null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [runDialogRubricId, setRunDialogRubricId] = useState<string | null>(null);

  // The run-eval dialog needs the team's rubrics in RubricSummary shape for its
  // rubric picker. created_at isn't shown in the dialog, but the type wants it.
  const rubricSummaries: RubricSummary[] = useMemo(
    () =>
      rubrics.map((r) => ({
        id: r.id,
        name: r.name,
        evaluation_mode: r.mode,
        created_at: r.createdAt,
      })),
    [rubrics]
  );

  function openRunDialog(rubricId: string) {
    if (!canWrite) return; // Readonly Members can't create runs.
    track({ name: "eval_run.dialog_opened" });
    setRunDialogRubricId(rubricId);
  }

  const t0 = today - rangeDays * DAY_MS;

  const runsByRubric = useMemo(() => {
    const m = new Map<string, DashRun[]>();
    runs.forEach((r) => {
      const arr = m.get(r.rubricId) ?? [];
      arr.push(r);
      m.set(r.rubricId, arr);
    });
    return m;
  }, [runs]);

  const visible = useMemo(() => {
    const s = new Set(rubrics.map((r) => r.id));
    hidden.forEach((id) => s.delete(id));
    return s;
  }, [hidden, rubrics]);

  // ---- per-rubric stats within range ------------------------------------
  const stats: RubricStat[] = useMemo(
    () =>
      rubrics.map((r) => {
        const inRange = (runsByRubric.get(r.id) ?? []).filter((x) => x.t >= t0 && x.t <= today);
        const completed = inRange
          .filter((x) => x.score != null)
          .sort((a, b) => a.t - b.t);
        const latest = completed[completed.length - 1] ?? null;
        const prev = completed[completed.length - 2] ?? null;
        const first = completed[0] ?? null;
        const latestRun = [...inRange].sort((a, b) => b.t - a.t)[0] ?? null;
        return {
          rubric: r,
          latest: latest ? latest.score : null,
          delta: latest && prev ? (latest.score as number) - (prev.score as number) : null,
          periodDelta: latest && first ? (latest.score as number) - (first.score as number) : null,
          runCount: inRange.length,
          latestRun,
          spark: completed,
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
  const feed = useMemo(() => {
    const items = runs
      .filter((x) => x.t >= t0 && x.t <= today)
      .map((x) => ({ ...x, rubricName: rubrics.find((r) => r.id === x.rubricId)?.name ?? "" }))
      .sort((a, b) => b.t - a.t);
    return items.slice(0, 8);
  }, [runs, rubrics, t0, today]);

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
        <Header
          teamName={teamName}
          rubricCount={0}
          runCount={0}
          rangeDays={rangeDays}
          onRange={setRangeDays}
        />
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-hairline-cool bg-card px-6 py-20 text-center shadow-card">
          <p className="text-base font-semibold text-ink">No eval data yet</p>
          <p className="max-w-sm text-sm text-fg-3">
            Author a rubric and run it against your AI outputs — scores, trends, and the
            leaderboard will populate here.
          </p>
          <Link
            href="/rubrics"
            className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-fg-on-accent transition-colors hover:bg-accent-hover"
          >
            Go to rubrics
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
        rangeDays={rangeDays}
        onRange={setRangeDays}
      />

      {/* KPI ROW */}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Avg rubric score" pill={<Pill className="bg-accent text-fg-on-accent">live</Pill>}>
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {pct(kpi.avgNow)}%
          </span>
          <Delta value={kpi.periodDelta} />
        </KpiCard>

        <KpiCard label="Rubrics passing" meta={`≥ ${pct(PASSING_THRESHOLD)}%`}>
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {kpi.passing}
          </span>
          <span className="font-mono text-base font-semibold text-fg-3">/ {kpi.totalRubrics}</span>
        </KpiCard>

        <KpiCard label="Eval runs" meta={`last ${rangeDays}d`}>
          <span className="font-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
            {kpi.total}
          </span>
        </KpiCard>

        <KpiCard
          label="Failed runs"
          pill={<Pill className="border border-hairline-cool bg-card font-semibold text-ink">attention</Pill>}
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
          <div className="flex min-h-[60px] items-center justify-between gap-4 border-b border-hairline px-5 py-4">
            <div>
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">Score over time</h2>
              <p className="mt-0.5 text-xs text-fg-3">
                Overall eval score per rubric · click a rubric to focus it
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
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
                      aria-label={off ? `Show ${r.name} on chart` : `Hide ${r.name} from chart`}
                      title={off ? "Show on chart" : "Hide from chart"}
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
                      aria-label={`Focus ${r.name}`}
                      title="Focus on chart"
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
              rangeDays={rangeDays}
              today={today}
              visible={visible}
              focusedId={focusedId && visible.has(focusedId) ? focusedId : null}
              onSelect={setFocusedId}
            />
          </div>
        </section>

        {/* FOCUS DARK CARD */}
        <FocusCard
          focused={focused}
          canWrite={canWrite}
          onRunEval={() => focused && openRunDialog(focused.rubric.id)}
        />
      </div>

      {/* LOWER GRID: leaderboard + side */}
      <div className="grid items-start gap-4 lg:grid-cols-[1.95fr_1fr]">
        <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
          <div className="flex min-h-[60px] items-center justify-between border-b border-hairline px-5 py-4">
            <div>
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">Rubric leaderboard</h2>
              <p className="mt-0.5 text-xs text-fg-3">Ranked by latest score · trend over the window</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 p-3">
            {sortedLb.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-fg-3">
                No scored runs in this window.
              </p>
            )}
            {sortedLb.map((s, i) => {
              const isFocus = s.rubric.id === focusedId;
              return (
                <button
                  key={s.rubric.id}
                  onClick={() => setFocusedId(s.rubric.id)}
                  className={`grid w-full grid-cols-[22px_1fr_auto_auto_auto] items-center gap-4 rounded-lg border px-3.5 py-3 text-left transition-colors ${
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
                      <span className="capitalize">{s.rubric.mode.replace("_", " ")}</span> · {s.runCount} runs
                    </div>
                  </div>
                  <Sparkline series={s.spark} color={isFocus ? "var(--ink)" : s.rubric.tone} />
                  <Delta value={s.delta} width />
                  <span className={`w-[46px] text-right font-mono text-[17px] font-bold tabular-nums ${scoreClass(s.latest as number)}`}>
                    {pct(s.latest as number)}%
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
            <div className="flex min-h-[60px] items-center justify-between border-b border-hairline px-5 py-4">
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">Run status</h2>
              <span className="font-mono text-xs text-fg-3">{kpi.total} total</span>
            </div>
            <div className="px-5 py-5">
              <StatusMix counts={kpi.statusMix} />
            </div>
          </section>

          <section className="flex flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
            <div className="flex min-h-[60px] items-center justify-between border-b border-hairline px-5 py-4">
              <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-ink">Recent runs</h2>
            </div>
            <div className="px-5 pb-2 pt-1.5">
              <div className="flex flex-col">
                {feed.length === 0 && (
                  <p className="py-6 text-center text-sm text-fg-3">No runs in this window.</p>
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
                        <span>{relTime(x.t, today)}</span>
                      </div>
                    </div>
                    {x.score != null ? (
                      <span className={`font-mono text-sm font-bold tabular-nums ${scoreClass(x.score)}`}>
                        {pct(x.score)}%
                      </span>
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
  rangeDays,
  onRange,
}: {
  teamName: string;
  rubricCount: number;
  runCount: number;
  rangeDays: RangeDays;
  onRange: (d: RangeDays) => void;
}) {
  return (
    <header className="flex items-end justify-between gap-6 pb-5 pt-2">
      <div>
        <h1 className="sr-only">Eval results</h1>
        <p className="flex items-center gap-2 text-sm text-fg-2">
          <span className="font-semibold text-ink">{teamName}</span>
          <span className="text-fg-4">·</span>
          <span>{rubricCount} rubrics</span>
          <span className="text-fg-4">·</span>
          <span className="font-mono">{runCount}</span>
          <span>runs in window</span>
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="inline-flex gap-0.5 rounded-full border border-hairline-cool bg-card p-1">
          {RANGE_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => onRange(d)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                rangeDays === d ? "bg-ink text-fg-on-ink" : "text-fg-2 hover:text-ink"
              }`}
            >
              {d}d
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
  canWrite,
  onRunEval,
}: {
  focused: RubricStat | null;
  canWrite: boolean;
  onRunEval: () => void;
}) {
  if (!focused) return null;
  const { rubric } = focused;
  return (
    <section className="hero-card flex flex-col overflow-hidden rounded-2xl bg-ink-soft text-white">
      <div className="flex min-h-[60px] items-center justify-between border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="text-accent">
            <SparklesIcon size={16} />
          </span>
          <h2 className="m-0 text-base font-semibold tracking-[-0.01em] text-white">In focus</h2>
        </div>
        <FocusStatusBadge run={focused.latestRun} />
      </div>
      <div className="flex flex-1 flex-col gap-[18px] px-5 py-5">
        <div>
          <div className="text-sm font-semibold text-white">{rubric.name}</div>
          <div className="mt-0.5 text-xs text-fg-4">
            <span className="capitalize">{rubric.mode.replace("_", " ")}</span> · {focused.runCount} runs in window
          </div>
        </div>

        <div className="flex items-end gap-3.5">
          <span className="font-mono text-[64px] font-bold leading-[0.95] tracking-[-0.03em] tabular-nums text-white">
            {focused.latest != null ? `${pct(focused.latest)}%` : "—"}
          </span>
          <div className="pb-2">
            <Delta value={focused.delta} light />
            <div className="mt-0.5 text-[11px] text-fg-4">vs previous run</div>
          </div>
        </div>

        <div className="flex flex-col gap-[11px]">
          {rubric.criteria.map((c) => (
            <div key={c.name} className="flex flex-col gap-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-fg-4">
                  {c.name}
                  <span className="ml-[7px] font-mono text-fg-4">w {c.weight.toFixed(2)}</span>
                </span>
                <span
                  className="font-mono font-bold"
                  style={{ color: c.score != null ? scoreHexDark(c.score) : "#71717A" }}
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
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-4">Recent runs</div>
          {focused.spark
            .slice(-4)
            .reverse()
            .map((run) => (
              <div key={run.id} className="flex items-center justify-between text-xs">
                <span className="font-mono text-fg-4">
                  #{run.runNo} · {fmtDay(run.t)}
                </span>
                <span className="font-mono font-bold" style={{ color: scoreHexDark(run.score as number) }}>
                  {pct(run.score as number)}%
                </span>
              </div>
            ))}
          {focused.spark.length === 0 && (
            <div className="text-xs text-fg-4">No scored runs in this window.</div>
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
              Run eval
            </button>
          )}
          <Link
            href="/rubrics"
            className={`flex items-center justify-center gap-1.5 rounded-full bg-white/10 px-[18px] py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-white/[0.16] ${
              canWrite ? "" : "flex-1"
            }`}
          >
            View runs
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
        className={`inline-flex items-center justify-end font-mono text-xs font-semibold text-fg-4 ${
          width ? "w-[52px]" : ""
        }`}
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
  if (!run) return null;
  if (run.status === "running" || run.status === "queued") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent"
      >
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
        {run.status === "queued" ? "Queued" : "Running"}
      </span>
    );
  }
  if (run.status === "failed") {
    return (
      <span
        className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-red-400"
        style={{ background: "rgba(220,38,38,0.16)" }}
      >
        Failed
      </span>
    );
  }
  if (run.status === "skipped") {
    return (
      <span
        className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-fg-4"
        style={{ background: "rgba(161,161,170,0.16)" }}
      >
        Skipped
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-emerald-400"
      style={{ background: "rgba(52,211,153,0.16)" }}
    >
      Completed
    </span>
  );
}

function FeedStatusBadge({ status }: { status: EvalRunStatus }) {
  const map: Record<EvalRunStatus, { label: string; className: string }> = {
    queued: { label: "Queued", className: "bg-card-warm text-fg-2" },
    running: { label: "Running", className: "bg-info-bg text-info-fg" },
    completed: { label: "Done", className: "bg-success-bg text-success-fg" },
    failed: { label: "Failed", className: "bg-danger-bg text-danger-fg" },
    skipped: { label: "Skipped", className: "bg-card-warm text-fg-3" },
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
