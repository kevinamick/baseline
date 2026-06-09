"use client";

// Shared primitives for the stepped wizard dialogs (optimization, schedules, …): the
// canonical text-input class, the number-input parser, and the Review-step row.

// Parse a number-input value to a non-negative integer, mapping blank/NaN to 0 so per-field
// validation fires instead of NaN reaching Review or the server. 0 is caught by the same
// validation (or means "off" where a field documents it).
export function toCount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";

// One label/value line on a wizard's Review step. `labelWidth` preserves each wizard's
// column width (schedules uses the w-28 default; optimizations passes w-32).
export function ReviewRow({
  label,
  value,
  labelWidth = "w-28",
}: {
  label: string;
  value: string;
  labelWidth?: string;
}) {
  return (
    <div className="flex gap-3 border-b border-hairline py-2 text-sm last:border-0">
      <span className={`${labelWidth} shrink-0 text-fg-3`}>{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink">{value}</span>
    </div>
  );
}
