import type { ReactNode } from "react";

// Header status pill shared by the signed-in surfaces. Tones map to the brand
// palette — a warm-neutral idle state (never cool gray on cream paper), the
// emerald "on/available" state that matches the schedule On badges, a
// butter-accent "active" state for in-flight work (pair with `pulse`), and an
// amber "warning" state for a real-time slot that's maxed out and blocking
// the user (e.g. Active Runs at capacity — distinct from `active`, which
// merely signals motion, not a blocker).
type PillTone = "positive" | "neutral" | "active" | "warning";

const TONE: Record<PillTone, { pill: string; dot: string }> = {
  positive: { pill: "bg-success-bg text-success-fg", dot: "bg-success" },
  neutral: { pill: "bg-card-warm text-fg-3", dot: "bg-hairline-strong" },
  active: { pill: "bg-accent-soft text-accent-ink", dot: "bg-accent-ink" },
  warning: { pill: "bg-warning-bg text-warning-fg", dot: "bg-warning" },
};

export function StatusPill({
  tone,
  pulse = false,
  children,
}: {
  tone: PillTone;
  pulse?: boolean;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${t.pill}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${t.dot} ${pulse ? "animate-pulse-soft" : ""}`}
      />
      {children}
    </span>
  );
}
