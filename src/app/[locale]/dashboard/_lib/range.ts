import { DAY_MS, RANGE_OPTIONS, fmtDay, fmtDayYear, type DashRun, type RangeDays } from "./dashboard-data";

// Shortest custom span the codec will accept, so a hand-edited or mangled URL
// can't produce a degenerate (sub-second) x-axis. Mirrors the brush floor.
const MIN_CUSTOM_SPAN_MS = 3_600_000;

// How many of the focused rubric's most recent runs the Auto range fits. Also
// sizes the server's per-rubric top-up fetch, so Auto always has its N runs.
export const AUTO_FIT_RUNS = 10;

// Auto never zooms tighter than this — a burst of same-day runs should still
// render on a readable axis, not an hours-wide one.
export const AUTO_MIN_SPAN_MS = 7 * DAY_MS;

// Auto with a runless rubric, and the cards in auto/custom mode, fall back here.
const AUTO_FALLBACK_DAYS: RangeDays = 30;

// Left padding so the anchor run doesn't sit on the y-axis.
const AUTO_PAD = 0.04;

// The chart's range control: Auto fits the focused rubric, a preset pins a
// fixed window (and also governs the cards), a brush pins an explicit span.
export type RangeState =
  | { mode: "auto" }
  | { mode: "preset"; days: RangeDays }
  | { mode: "custom"; t0: number; t1: number };

export interface ChartDomain {
  t0: number;
  t1: number;
}

// Fit the chart to the last AUTO_FIT_RUNS of `runs` (ascending, any status).
export function computeAutoDomain(runs: DashRun[], today: number): ChartDomain {
  if (runs.length === 0) {
    return { t0: today - AUTO_FALLBACK_DAYS * DAY_MS, t1: today };
  }
  const anchor = runs[Math.max(0, runs.length - AUTO_FIT_RUNS)].t;
  const t0 = Math.min(anchor - AUTO_PAD * (today - anchor), today - AUTO_MIN_SPAN_MS);
  return { t0, t1: today };
}

export function domainFor(state: RangeState, focusedRuns: DashRun[], today: number): ChartDomain {
  switch (state.mode) {
    case "auto":
      return computeAutoDomain(focusedRuns, today);
    case "preset":
      return { t0: today - state.days * DAY_MS, t1: today };
    case "custom":
      return { t0: state.t0, t1: state.t1 };
  }
}

// The cards (KPIs, leaderboard counts, feed, status mix) keep a stable window:
// the pinned preset when there is one, else the default. Auto and brush are
// chart-only and never re-window the cards.
export function cardsWindowDays(state: RangeState): RangeDays {
  return state.mode === "preset" ? state.days : AUTO_FALLBACK_DAYS;
}

// "Mar 12 – Jun 10 · auto" — years appear only when the span crosses one.
export function formatSpan(domain: ChartDomain, state: RangeState): string {
  const crossesYear =
    new Date(domain.t0).getFullYear() !== new Date(domain.t1).getFullYear();
  const day = crossesYear ? fmtDayYear : fmtDay;
  const mode = state.mode === "preset" ? `${state.days}d` : state.mode;
  return `${day(domain.t0)} – ${day(domain.t1)} · ${mode}`;
}

// ---- URL codec -------------------------------------------------------------
// range=auto | 7 | 30 | 90 | <t0>-<t1> (epoch ms). Garbage falls back to auto.

export function parseRangeParam(value: string | null): RangeState {
  if (!value || value === "auto") return { mode: "auto" };
  const days = Number(value);
  if ((RANGE_OPTIONS as readonly number[]).includes(days)) {
    return { mode: "preset", days: days as RangeDays };
  }
  const m = /^(\d+)-(\d+)$/.exec(value);
  if (m) {
    const t0 = Number(m[1]);
    const t1 = Number(m[2]);
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 - t0 >= MIN_CUSTOM_SPAN_MS) {
      return { mode: "custom", t0, t1 };
    }
  }
  return { mode: "auto" };
}

export function serializeRangeParam(state: RangeState): string {
  switch (state.mode) {
    case "auto":
      return "auto";
    case "preset":
      return String(state.days);
    case "custom":
      return `${Math.round(state.t0)}-${Math.round(state.t1)}`;
  }
}
