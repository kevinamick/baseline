"use client";

import { useTranslations } from "next-intl";

interface Props {
  rubricCount: number;
  runCount: number;
  avgScore: number | null;
}

export function RubricsHeader({
  rubricCount,
  runCount,
  avgScore,
}: Props) {
  const t = useTranslations("Rubrics");
  return (
    <header className="flex shrink-0 flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div>
        <h1 className="sr-only">{t("list.srTitle")}</h1>
        <p className="text-[15px] text-fg-2">{t("list.intro")}</p>
      </div>

      {/* Equal 3-up grid on mobile (cards would otherwise stay full-width and
          overflow); the fixed row returns at sm+. */}
      <div className="grid grid-cols-3 gap-2 sm:flex sm:shrink-0 sm:gap-3">
        <KpiCard
          label={t("list.kpiRubrics")}
          value={rubricCount}
          valueClassName="text-ink"
          testId="kpi-rubrics"
        />
        <KpiCard
          label={t("list.kpiEvalRuns")}
          value={runCount}
          valueClassName="text-accent"
          testId="kpi-eval-runs"
        />
        <KpiCard
          label={t("list.kpiAvgScore")}
          value={avgScore != null ? `${Math.round(avgScore * 100)}%` : "—"}
          valueClassName={avgScore != null ? "text-ink" : "text-fg-3"}
          testId="kpi-avg-score"
        />
      </div>
    </header>
  );
}

function KpiCard({
  label,
  value,
  valueClassName = "",
  testId,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1 rounded-lg border border-hairline bg-card px-3 py-2.5 shadow-sm sm:px-5 sm:py-3"
      data-testid={testId}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-fg-3">
        {label}
      </span>
      <span
        className={`font-mono text-2xl font-bold tabular-nums leading-none ${valueClassName}`}
      >
        {value}
      </span>
    </div>
  );
}
