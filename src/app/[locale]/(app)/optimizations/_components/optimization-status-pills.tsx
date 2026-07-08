"use client";

import { useTranslations } from "next-intl";
import { StatusPill } from "@/app/_components/status-pill";

// Optimization Runs are gated by two independent, differently-shaped limits (#467):
// a real-time concurrency slot (Active Runs — only one optimization run executes per
// org at a time) and a monthly wallet (Monthly Runs — the plan's included run count,
// decrementing over the billing period). Rendering both as a single fraction/badge
// conflated a live pipeline status with a static balance, so this renders them as two
// separate indicators with opposite polarities: Active Runs is "ready" at 0 (a positive/
// success theme) and "busy" at capacity (a warning theme, the user must wait); Monthly
// Runs stays a neutral "wallet balance" regardless of how much is left.
const MAX_ACTIVE_RUN_SLOTS = 1;

export function OptimizationStatusPills({
  hasActiveRun,
  runsRemaining,
}: {
  hasActiveRun: boolean;
  runsRemaining: number;
}) {
  const t = useTranslations("Optimizations");
  const activeRunSlots = hasActiveRun ? 1 : 0;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <StatusPill tone={hasActiveRun ? "warning" : "positive"} pulse={hasActiveRun}>
        {t("activeRunSlots", { active: activeRunSlots, max: MAX_ACTIVE_RUN_SLOTS })}
      </StatusPill>
      <StatusPill tone="neutral">
        {t("monthlyRunsLeft", { count: runsRemaining })}
      </StatusPill>
    </div>
  );
}
