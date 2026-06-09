import type { ReactNode } from "react";

// Header status pill shared by the signed-in surfaces. Tones map to the brand
// palette — a warm-neutral idle state (never cool gray on cream paper), the
// emerald "on/available" state that matches the schedule On badges, and a
// butter-accent "active" state for in-flight work (pair with `pulse`).
type PillTone = "positive" | "neutral" | "active";

const TONE: Record<PillTone, { pill: string; dot: string }> = {
  positive: { pill: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  neutral: { pill: "bg-card-warm text-zinc-500", dot: "bg-hairline-strong" },
  active: { pill: "bg-accent-soft text-accent-ink", dot: "bg-accent-ink" },
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
