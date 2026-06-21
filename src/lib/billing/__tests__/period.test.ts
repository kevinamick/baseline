import { describe, it, expect } from "vitest";
import { anniversaryPeriod } from "../period";

const d = (iso: string) => new Date(iso);

describe("anniversaryPeriod", () => {
  it("anchors the period to the anniversary day, not the calendar month", () => {
    const { start, end } = anniversaryPeriod(
      d("2026-03-15T08:30:00Z"),
      d("2026-06-20T00:00:00Z")
    );
    expect(start.toISOString()).toBe("2026-06-15T08:30:00.000Z");
    expect(end.toISOString()).toBe("2026-07-15T08:30:00.000Z");
  });

  it("uses the anchor itself while inside the first period", () => {
    const anchor = d("2026-06-01T12:00:00Z");
    const { start, end } = anniversaryPeriod(anchor, d("2026-06-12T00:00:00Z"));
    expect(start.toISOString()).toBe(anchor.toISOString());
    expect(end.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("clamps a created-Jan-31 Team to Feb 28 in a non-leap year (Stripe-style)", () => {
    const anchor = d("2026-01-31T10:00:00Z");
    // Mid-February: still inside the period that started Jan 31.
    const feb = anniversaryPeriod(anchor, d("2026-02-15T00:00:00Z"));
    expect(feb.start.toISOString()).toBe("2026-01-31T10:00:00.000Z");
    expect(feb.end.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    // After Feb 28: the new period runs Feb 28 → Mar 31 (back to the real day).
    const mar = anniversaryPeriod(anchor, d("2026-03-10T00:00:00Z"));
    expect(mar.start.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(mar.end.toISOString()).toBe("2026-03-31T10:00:00.000Z");
  });

  it("clamps to Feb 29 in a leap year", () => {
    const anchor = d("2024-01-31T00:00:00Z");
    const { start, end } = anniversaryPeriod(anchor, d("2024-03-01T00:00:00Z"));
    expect(start.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(end.toISOString()).toBe("2024-03-31T00:00:00.000Z");
  });

  it("clamps day-31 anchors in 30-day months", () => {
    const anchor = d("2026-01-31T00:00:00Z");
    const { start, end } = anniversaryPeriod(anchor, d("2026-04-30T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-31T00:00:00.000Z");
  });

  it("starts a new period exactly at the boundary instant", () => {
    const anchor = d("2026-01-31T10:00:00Z");
    const boundary = d("2026-02-28T10:00:00Z");
    const { start } = anniversaryPeriod(anchor, boundary);
    expect(start.toISOString()).toBe(boundary.toISOString());
  });

  it("yields adjacent, non-overlapping periods — exactly one grant per cycle", () => {
    // Walk a full year of a last-day-of-month anchor one day at a time; the
    // period starts encountered must be strictly increasing and each period's
    // end must equal the next period's start (no gap → no double-grant seam).
    const anchor = d("2025-12-31T23:59:59Z");
    const starts: string[] = [];
    const endsByStart = new Map<string, string>();
    for (let day = 0; day < 366; day++) {
      const now = new Date(anchor.getTime() + day * 24 * 60 * 60 * 1000);
      const { start, end } = anniversaryPeriod(anchor, now);
      const s = start.toISOString();
      if (starts[starts.length - 1] !== s) starts.push(s);
      endsByStart.set(s, end.toISOString());
    }
    expect(starts).toEqual([...starts].sort());
    expect(new Set(starts).size).toBe(starts.length);
    for (let i = 0; i < starts.length - 1; i++) {
      expect(endsByStart.get(starts[i])).toBe(starts[i + 1]);
    }
    // ~12 boundaries in 366 days.
    expect(starts.length).toBeGreaterThanOrEqual(12);
    expect(starts.length).toBeLessThanOrEqual(13);
  });

  it("falls back to the anchor when now precedes it (clock skew)", () => {
    const anchor = d("2026-06-10T00:00:00Z");
    const { start } = anniversaryPeriod(anchor, d("2026-06-09T23:00:00Z"));
    expect(start.toISOString()).toBe(anchor.toISOString());
  });
});
