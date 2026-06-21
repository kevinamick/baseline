/**
 * Point-period anchors (#180, ADR-0008). Periods are anchored to plan start,
 * never the calendar month (calendar months are gameable: subscribe on the
 * 28th, get a fresh grant on the 1st). Paid Teams use the Stripe period from
 * the mirror; Free Teams — who have no subscription — anchor to the Team's
 * creation anniversary, computed here with Stripe-style day clamping.
 *
 * Pure date math (UTC), no I/O — unit-testable in isolation.
 */

export interface PointPeriod {
  start: Date;
  end: Date;
}

function daysInUtcMonth(year: number, month: number): number {
  // Day 0 of the next month = last day of this one.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The monthly boundary for (year, month) given an anchor date: the anchor's
 * day-of-month clamped to the month's length (created Jan 31 → Feb 28 in a
 * non-leap year, Apr 30, …), at the anchor's UTC time of day. This is how
 * Stripe schedules month-end billing anniversaries.
 */
function clampedBoundary(anchor: Date, year: number, month: number): Date {
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds()
    )
  );
}

/**
 * The current anniversary period containing `now`: start ≤ now < end, where
 * both bounds are clamped monthly anniversaries of `anchor`. A Team created on
 * the last day of a month gets exactly one period per cycle — the clamped
 * boundaries are strictly increasing, so periods never overlap or double up
 * across a calendar boundary.
 */
export function anniversaryPeriod(anchor: Date, now: Date): PointPeriod {
  if (now < anchor) {
    // Clock skew (mirror writes vs app clock); the first period still starts
    // at the anchor rather than inventing time before the Team existed.
    return { start: anchor, end: clampedBoundary(anchor, anchor.getUTCFullYear(), anchor.getUTCMonth() + 1) };
  }

  // Candidate boundary in now's month; if it's in the future, step back one
  // month. Date.UTC wraps out-of-range months (month -1 → December of the
  // prior year), so no manual year arithmetic is needed.
  const year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let start = clampedBoundary(anchor, year, month);
  if (start > now) {
    month -= 1;
    start = clampedBoundary(anchor, year, month);
  }

  const end = clampedBoundary(anchor, year, month + 1);
  return { start, end };
}
