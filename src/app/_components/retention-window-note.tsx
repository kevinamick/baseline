"use client";

import { useRetentionDays } from "./billing-context";

/** "the last 90 days" / "the last 3 years" — a window in human terms. */
export function retentionWindowText(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return `the last ${years} year${years === 1 ? "" : "s"}`;
  }
  return `the last ${days} days`;
}

/**
 * Labels the Retention Window boundary on run-history surfaces (#187, ADR-0008):
 * runs older than the plan's window are soft-deleted and no longer shown, so the
 * list says how far back it reaches. Reads the window from BillingContext by
 * default; pass `days` on a surface that doesn't seed the provider.
 */
export function RetentionWindowNote({
  days,
  className,
}: {
  days?: number;
  className?: string;
}) {
  const contextDays = useRetentionDays();
  const windowDays = days ?? contextDays;
  return (
    <p className={className ?? "px-2 pb-1 pt-2 text-center text-[11px] text-fg-4"}>
      Showing {retentionWindowText(windowDays)} — your plan&rsquo;s retention window
    </p>
  );
}
