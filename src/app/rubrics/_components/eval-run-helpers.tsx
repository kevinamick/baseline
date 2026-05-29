import type { EvalRunStatus } from "@/types/eval-run";

// The canonical Baseline score thresholds: ≥0.80 success, 0.50–0.79 warning,
// <0.50 error. Rendered in Geist Mono wherever a score appears.
export function scoreColor(score: number): string {
  if (score >= 0.8) return "text-emerald-600";
  if (score >= 0.5) return "text-amber-600";
  return "text-red-600";
}

const STATUS_CONFIG: Record<EvalRunStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-zinc-100 text-zinc-600" },
  running: { label: "Running", className: "bg-blue-50 text-blue-700" },
  completed: { label: "Completed", className: "bg-emerald-50 text-emerald-700" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700" },
};

export function StatusBadge({ status }: { status: EvalRunStatus }) {
  const { label, className } = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className}`}
    >
      {status === "running" && (
        <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse-soft" />
      )}
      {label}
    </span>
  );
}
