import type { EvalRunStatus } from "@/types/eval-run";

export function scoreColor(score: number): string {
  if (score >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

const STATUS_CONFIG: Record<EvalRunStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  running: { label: "Running", className: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400" },
  completed: { label: "Completed", className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400" },
};

export function StatusBadge({ status }: { status: EvalRunStatus }) {
  const { label, className } = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${className}`}>
      {status === "running" && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
      )}
      {label}
    </span>
  );
}
