"use client";

import { useLocale } from "@/lib/i18n/context";

interface Props {
  teamName: string;
  rubricCount: number;
  runCount: number;
  avgScore: number | null;
}

export function RubricsHeader({
  teamName,
  rubricCount,
  runCount,
  avgScore,
}: Props) {
  const { t } = useLocale();

  return (
    <header className="flex items-end justify-between gap-6 py-2 shrink-0">
      <div>
        <h1 className="text-[2.75rem] font-semibold leading-[1.05] tracking-[-0.028em] text-ink">
          {t.rubrics.header.welcome}
          <br />
          {teamName}.
        </h1>
        <p className="mt-1.5 text-[15px] text-zinc-700">
          {t.rubrics.header.subheading}
        </p>
      </div>

      <div className="flex shrink-0 gap-7">
        <Kpi label={t.rubrics.header.rubricsKpi}>
          <Pill className="bg-ink text-white">{rubricCount}</Pill>
        </Kpi>
        <Kpi label={t.rubrics.header.evalRunsKpi}>
          <Pill className="bg-accent font-bold text-ink">{runCount}</Pill>
        </Kpi>
        <Kpi label={t.rubrics.header.avgScoreKpi}>
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
      className={`inline-flex min-w-[3.5rem] justify-center items-center rounded-full px-4 py-1.5 font-mono text-xs font-semibold tabular-nums ${className}`}
    >
      {children}
    </span>
  );
}
