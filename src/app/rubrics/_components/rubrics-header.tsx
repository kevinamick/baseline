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
  return (
    <header className="flex shrink-0 items-center justify-between gap-6 py-2">
      <div>
        <h1 className="sr-only">Rubrics</h1>
        <p className="text-[15px] text-fg-2">
          Author rubrics on the left. Eval runs accumulate on the right.
        </p>
      </div>

      <div className="flex shrink-0 gap-3">
        <KpiCard
          label="Rubrics"
          value={rubricCount}
          valueClassName="text-ink"
          testId="kpi-rubrics"
        />
        <KpiCard
          label="Eval runs"
          value={runCount}
          valueClassName="text-accent"
          testId="kpi-eval-runs"
        />
        <KpiCard
          label="Avg score"
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
      className="flex flex-col items-center gap-1 rounded-lg border border-hairline bg-card px-5 py-3 shadow-sm"
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
