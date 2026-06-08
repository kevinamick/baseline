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
        <p className="text-[15px] text-zinc-700">
          Author rubrics on the left. Eval runs accumulate on the right.
        </p>
      </div>

      <div className="flex shrink-0 gap-7">
        <Kpi label="Rubrics">
          <Pill className="bg-ink text-white">{rubricCount}</Pill>
        </Kpi>
        <Kpi label="Eval runs">
          <Pill className="bg-accent font-bold text-ink">{runCount}</Pill>
        </Kpi>
        <Kpi label="Avg score">
          <Pill className="border border-hairline-cool bg-white text-ink">
            {avgScore != null ? `${Math.round(avgScore * 100)}%` : "—"}
          </Pill>
        </Kpi>
      </div>
    </header>
  );
}

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-xs text-zinc-700">{label}</span>
      {children}
    </div>
  );
}

function Pill({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex min-w-[3.5rem] justify-center items-center rounded-full px-4 py-1 font-mono text-xs font-semibold tabular-nums ${className}`}
    >
      {children}
    </span>
  );
}
