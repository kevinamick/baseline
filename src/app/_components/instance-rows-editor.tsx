"use client";

import type { InstanceRow } from "@/types/instances";
import { inputCls } from "./form-styles";

export const emptyInstanceRow = (): InstanceRow => ({
  userInput: "",
  expectedOutput: "",
  retrievalContext: "",
});

// The manual instance/input row editor shared by the optimization and schedules wizards:
// one "Input N" card per row (user input + optional expected/retrieval pair + remove),
// plus the "+ Add input" action. Optional `children` render above the rows (e.g. the
// schedules wizard's intro copy).
export function InstanceRowsEditor({
  rows,
  setRows,
  children,
}: {
  rows: InstanceRow[];
  setRows: React.Dispatch<React.SetStateAction<InstanceRow[]>>;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {children}
      {rows.map((row, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border border-hairline bg-card-warm p-4">
          <div className="flex items-center justify-between">
            {/* fg-2, not fg-3: at 12px the uppercase label on bg-card-warm must clear the
                4.5:1 AA contrast floor (fg-3 lands at 4.38:1). */}
            <span className="text-xs font-semibold uppercase tracking-wide text-fg-2">
              Input {i + 1}
            </span>
            <button
              type="button"
              disabled={rows.length === 1}
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              aria-label={`Remove input ${i + 1}`}
              className="text-base leading-none text-fg-4 transition-colors hover:text-danger disabled:pointer-events-none disabled:opacity-0"
            >
              ×
            </button>
          </div>
          <textarea
            rows={2}
            value={row.userInput}
            onChange={(e) =>
              setRows((prev) => prev.map((r, j) => (j === i ? { ...r, userInput: e.target.value } : r)))
            }
            placeholder="User input…"
            className={`${inputCls} resize-none`}
          />
          <div className="grid grid-cols-2 gap-3">
            <textarea
              rows={2}
              value={row.expectedOutput}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, j) => (j === i ? { ...r, expectedOutput: e.target.value } : r))
                )
              }
              placeholder="Expected output (optional)"
              className={`${inputCls} resize-none`}
            />
            <textarea
              rows={2}
              value={row.retrievalContext}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, j) => (j === i ? { ...r, retrievalContext: e.target.value } : r))
                )
              }
              placeholder="Retrieval context (optional)"
              className={`${inputCls} resize-none`}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows((prev) => [...prev, emptyInstanceRow()])}
        className="inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
      >
        + Add input
      </button>
    </div>
  );
}
