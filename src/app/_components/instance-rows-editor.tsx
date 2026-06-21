"use client";

import type { InstanceRow } from "@/types/instances";
import { inputCls } from "./form-styles";

export type InstanceSource = "manual" | "file" | "json";

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

const SOURCES: { id: InstanceSource; label: string }[] = [
  { id: "manual", label: "Manual" },
  { id: "file", label: "CSV file" },
  { id: "json", label: "JSON" },
];

const code = (chunks: React.ReactNode) => <code className="font-mono">{chunks}</code>;

// Tri-source instance ingester shared by the schedules and optimization wizards.
// State (source, rows, file, json) lives in the parent; this is a pure UI shell.
export function InstanceSourcePicker({
  source,
  setSource,
  intro,
  manualRows,
  setManualRows,
  fileName,
  fileNote,
  onFile,
  jsonText,
  setJsonText,
}: {
  source: InstanceSource;
  setSource: (s: InstanceSource) => void;
  intro?: React.ReactNode;
  manualRows: InstanceRow[];
  setManualRows: React.Dispatch<React.SetStateAction<InstanceRow[]>>;
  fileName: string;
  fileNote: string | null;
  onFile: (file: File) => void;
  jsonText: string;
  setJsonText: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-fit gap-1 rounded-lg bg-paper-warm p-1">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSource(s.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              source === s.id ? "bg-card text-ink shadow-sm" : "text-fg-3 hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {intro && <p className="text-xs text-fg-3">{intro}</p>}

      {source === "manual" && <InstanceRowsEditor rows={manualRows} setRows={setManualRows} />}

      {source === "file" && (
        <div className="flex flex-col gap-2">
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm">
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
              }}
            />
            Choose CSV…
          </label>
          {fileName && (
            <p className="text-xs text-fg-3">
              <span className="font-medium text-ink">{fileName}</span>
              {fileNote ? ` — ${fileNote}` : ""}
            </p>
          )}
          <p className="text-xs text-fg-4">
            Header row with a {code("user_input")} column (optionally {code("expected_output")},{" "}
            {code("retrieval_context")}).
          </p>
        </div>
      )}

      {source === "json" && (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Instances JSON"
            rows={10}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='[{"user_input": "How do I reset my password?", "expected_output": "Click Forgot password…"}]'
            className={`${inputCls} resize-none font-mono text-xs`}
          />
          <p className="text-xs text-fg-4">
            An array of objects, each with {code("user_input")} (optionally {code("expected_output")},{" "}
            {code("retrieval_context")}).
          </p>
        </div>
      )}
    </div>
  );
}
