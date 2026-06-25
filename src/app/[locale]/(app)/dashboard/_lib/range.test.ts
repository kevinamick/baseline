import { describe, expect, it } from "vitest";
import { DAY_MS, type DashRun } from "./dashboard-data";
import {
  AUTO_FIT_RUNS,
  AUTO_MIN_SPAN_MS,
  cardsWindowDays,
  computeAutoDomain,
  domainFor,
  spanCrossesYear,
  parseRangeParam,
  serializeRangeParam,
  type RangeState,
} from "./range";

// Local-time constructor: the year-boundary check reads local time, so this
// keeps the assertions timezone-independent.
const TODAY = new Date(2026, 5, 10, 12).getTime(); // Jun 10 2026, noon

function run(t: number, score: number | null = 0.8): DashRun {
  return { id: `r-${t}`, rubricId: "rub-1", runNo: 1, t, score, status: "completed" };
}

// n runs ending at `end`, spaced `gapDays` apart, ascending.
function runsEvery(n: number, gapDays: number, end: number): DashRun[] {
  return Array.from({ length: n }, (_, i) => run(end - (n - 1 - i) * gapDays * DAY_MS));
}

describe("computeAutoDomain", () => {
  it("falls back to 30d when the rubric has no runs", () => {
    expect(computeAutoDomain([], TODAY)).toEqual({ t0: TODAY - 30 * DAY_MS, t1: TODAY });
  });

  it("anchors on the Nth-most-recent run with left padding", () => {
    const runs = runsEvery(20, 5, TODAY - DAY_MS); // 20 runs, every 5 days
    const anchor = runs[runs.length - AUTO_FIT_RUNS].t;
    const { t0, t1 } = computeAutoDomain(runs, TODAY);
    expect(t1).toBe(TODAY);
    expect(t0).toBeLessThan(anchor); // padding puts the anchor inside the plot
    expect(t0).toBeCloseTo(anchor - 0.04 * (TODAY - anchor), -4);
  });

  it("fits all runs when there are fewer than N", () => {
    const runs = runsEvery(3, 30, TODAY - 10 * DAY_MS);
    const { t0 } = computeAutoDomain(runs, TODAY);
    expect(t0).toBeLessThan(runs[0].t);
  });

  it("zooms out for a dormant rubric instead of clipping it", () => {
    const runs = runsEvery(10, 2, TODAY - 120 * DAY_MS); // last run 4 months ago
    const { t0 } = computeAutoDomain(runs, TODAY);
    expect(t0).toBeLessThan(TODAY - 120 * DAY_MS);
    expect(t0).toBeLessThanOrEqual(runs[0].t);
  });

  it("never zooms tighter than the minimum span", () => {
    const runs = runsEvery(10, 0.01, TODAY - DAY_MS); // a same-day burst
    const { t0, t1 } = computeAutoDomain(runs, TODAY);
    expect(t1 - t0).toBe(AUTO_MIN_SPAN_MS);
  });
});

describe("domainFor", () => {
  it("maps presets to today-minus-days", () => {
    expect(domainFor({ mode: "preset", days: 90 }, [], TODAY)).toEqual({
      t0: TODAY - 90 * DAY_MS,
      t1: TODAY,
    });
  });

  it("passes custom spans through untouched", () => {
    const state: RangeState = { mode: "custom", t0: 100, t1: 200 };
    expect(domainFor(state, runsEvery(5, 1, TODAY), TODAY)).toEqual({ t0: 100, t1: 200 });
  });

  it("fits the focused rubric's runs in auto", () => {
    const runs = runsEvery(10, 2, TODAY - 120 * DAY_MS);
    expect(domainFor({ mode: "auto" }, runs, TODAY)).toEqual(computeAutoDomain(runs, TODAY));
  });
});

describe("cardsWindowDays", () => {
  it("uses the pinned preset", () => {
    expect(cardsWindowDays({ mode: "preset", days: 7 })).toBe(7);
  });

  it("stays at the default in auto and custom modes — chart-only ranges", () => {
    expect(cardsWindowDays({ mode: "auto" })).toBe(30);
    expect(cardsWindowDays({ mode: "custom", t0: 0, t1: 1 })).toBe(30);
  });
});

describe("spanCrossesYear", () => {
  it("is false for a same-year span", () => {
    const d = { t0: new Date(2026, 2, 12).getTime(), t1: new Date(2026, 5, 10).getTime() };
    expect(spanCrossesYear(d)).toBe(false);
  });

  it("is true when the span straddles a year boundary", () => {
    const d = { t0: new Date(2025, 10, 1).getTime(), t1: new Date(2026, 5, 10).getTime() };
    expect(spanCrossesYear(d)).toBe(true);
  });
});

describe("range URL param codec", () => {
  it("round-trips every mode", () => {
    const states: RangeState[] = [
      { mode: "auto" },
      { mode: "preset", days: 7 },
      { mode: "preset", days: 90 },
      { mode: "custom", t0: 1_700_000_000_000, t1: 1_710_000_000_000 },
    ];
    for (const s of states) {
      expect(parseRangeParam(serializeRangeParam(s))).toEqual(s);
    }
  });

  it("falls back to auto on garbage", () => {
    for (const v of [null, "", "junk", "15", "-5", "200-100", "100-100", "1e3-2e3"]) {
      expect(parseRangeParam(v)).toEqual({ mode: "auto" });
    }
  });

  it("rejects a degenerate custom span (sub-hour) from a mangled URL", () => {
    expect(parseRangeParam("1700000000000-1700000000001")).toEqual({ mode: "auto" });
    // A full-day span is accepted.
    const t0 = 1_700_000_000_000;
    expect(parseRangeParam(`${t0}-${t0 + 86_400_000}`)).toEqual({
      mode: "custom",
      t0,
      t1: t0 + 86_400_000,
    });
  });
});
