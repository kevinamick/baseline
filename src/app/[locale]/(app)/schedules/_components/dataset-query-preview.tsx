"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { previewDatasetConnection } from "@/app/actions/connections";
import {
  PREVIEW_MAX_ROWS,
  PREVIEW_WINDOW_MINUTES,
  type PreviewResult,
  type PreviewRow,
} from "@/lib/connections/preview-types";
import type { DatasetPreviewInput } from "@/lib/validation/schemas";

interface Props {
  // Recomputed on each render from the live wizard fields, so the click always tests the
  // current query/mapping/auth.
  buildSpec: () => DatasetPreviewInput;
  // True while the required fields aren't filled in (the parent owns that check, mirroring the
  // step's own validation) — the button is disabled with a hint rather than firing a doomed run.
  disabled: boolean;
}

// The four columns Baseline maps each row into, shown as literal field identifiers (not
// translated — they're the names the rubric pipeline reads).
const FIELD_COLUMNS: (keyof PreviewRow)[] = [
  "user_input",
  "agent_output",
  "expected_output",
  "retrieval_context",
];

// Inline "Test query" preview for a dataset Connection in the schedule wizard's System step
// (#39). Runs the configured query once (bounded window + row cap + timeout, all server-side)
// and shows a few sample rows as Baseline would interpret them, or a clear error — so a bad
// query, wrong field mapping, or auth problem surfaces here instead of in the first failed run.
export function DatasetQueryPreview({ buildSpec, disabled }: Props) {
  const t = useTranslations("Schedules.wizard.preview");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<PreviewResult | null>(null);

  function run() {
    const spec = buildSpec();
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await previewDatasetConnection(spec));
      } catch {
        setResult({ error: "unknown" });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hairline-cool bg-paper-warm p-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={disabled || pending}
          className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? t("running") : t("button")}
        </button>
        <p className="text-xs text-fg-3">
          {t("hint", { minutes: PREVIEW_WINDOW_MINUTES, rows: PREVIEW_MAX_ROWS })}
        </p>
      </div>

      {result !== null && ("error" in result ? (
        <PreviewError code={result.error} detail={result.detail} />
      ) : (
        <PreviewRows rows={result.rows} warning={result.warning} />
      ))}
    </div>
  );
}

function PreviewError({ code, detail }: { code: string; detail?: string }) {
  const t = useTranslations("Schedules.wizard.preview");
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/5 p-2.5"
    >
      <p className="text-xs font-medium text-danger">{t(`error.${code}`)}</p>
      {detail ? <code className="break-words font-mono text-[11px] text-fg-3">{detail}</code> : null}
    </div>
  );
}

function PreviewRows({
  rows,
  warning,
}: {
  rows: PreviewRow[];
  warning?: string;
}) {
  const t = useTranslations("Schedules.wizard.preview");

  if (rows.length === 0) {
    return <p className="text-xs text-fg-3">{t("empty")}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-ink">
        {t("resultsTitle", { count: rows.length })}
      </p>
      {warning ? (
        <p role="alert" className="text-xs text-warn">
          {t(`warning.${warning}`)}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-hairline-cool">
              {FIELD_COLUMNS.map((col) => (
                <th key={col} className="px-2 py-1.5 font-mono font-medium text-fg-3">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-hairline-cool/60 align-top">
                {FIELD_COLUMNS.map((col) => (
                  <td key={col} className="max-w-[14rem] truncate px-2 py-1.5 text-ink">
                    {row[col] ? (
                      <span title={row[col] ?? undefined}>{row[col]}</span>
                    ) : (
                      <span className="text-fg-3">{t("nullValue")}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
