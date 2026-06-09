import type { EvalRunStatus } from "@/types/eval-run";

// The canonical Baseline score thresholds: ≥0.80 success, 0.50–0.79 warning,
// <0.50 error. Rendered in Geist Mono wherever a score appears.
export function scoreColor(score: number): string {
  if (score >= 0.8) return "text-success";
  if (score >= 0.5) return "text-warning";
  return "text-danger-fg";
}

const STATUS_CONFIG: Record<EvalRunStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-card-warm text-fg-2" },
  running: { label: "Running", className: "bg-info-bg text-info-fg" },
  completed: { label: "Completed", className: "bg-success-bg text-success-fg" },
  failed: { label: "Failed", className: "bg-danger-bg text-danger-fg" },
  skipped: { label: "Skipped", className: "bg-card-warm text-fg-3" },
};

// Shared by the rubrics run views and the schedules run history. `title` surfaces a
// failed/skipped run's error_message on hover.
export function StatusBadge({ status, title }: { status: EvalRunStatus; title?: string }) {
  const { label, className } = STATUS_CONFIG[status];
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className}`}
    >
      {status === "running" && (
        <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse-soft" />
      )}
      {label}
    </span>
  );
}
