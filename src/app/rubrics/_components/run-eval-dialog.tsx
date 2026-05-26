"use client";

import { useRef, useState } from "react";
import { createEvalRun } from "@/app/actions/eval-runs";
import type { EvalRun, EvalRunRow } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";

type InputSource = "file" | "manual" | "json";

interface Props {
  rubrics: RubricSummary[];
  initialRubricId: string | null;
  onClose: () => void;
  onCreated: (run: EvalRun) => void;
}

const emptyRow = (): EvalRunRow => ({
  userInput: "",
  agentOutput: "",
  expectedOutput: "",
  retrievalContext: "",
});

export function RunEvalDialog({
  rubrics,
  initialRubricId,
  onClose,
  onCreated,
}: Props) {
  const [rubricId, setRubricId] = useState(initialRubricId ?? rubrics[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [source, setSource] = useState<InputSource>("manual");
  const [manualRows, setManualRows] = useState<EvalRunRow[]>([emptyRow()]);
  const [jsonText, setJsonText] = useState("");
  const [csvRows, setCsvRows] = useState<EvalRunRow[]>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function commitEmail() {
    const trimmed = emailInput.trim().replace(/,$/, "");
    if (trimmed && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmails((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setEmailInput("");
    }
  }

  function handleCsvFile(file: File) {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCsv(text);
      setCsvRows(parsed);
      if (parsed.length === 0) {
        setError(
          "Could not parse CSV. Expected columns: user_input, agent_output (optional: expected_output, retrieval_context)"
        );
      } else {
        setError(null);
      }
    };
    reader.readAsText(file);
  }

  function collectRows(): EvalRunRow[] | null {
    if (source === "manual") {
      const valid = manualRows.filter((r) => r.userInput.trim() && r.agentOutput.trim());
      if (valid.length === 0) {
        setError("Add at least one row with User Input and Agent Output filled in.");
        return null;
      }
      return valid.map((r) => ({
        userInput: r.userInput.trim(),
        agentOutput: r.agentOutput.trim(),
        expectedOutput: r.expectedOutput?.trim() || undefined,
        retrievalContext: r.retrievalContext?.trim() || undefined,
      }));
    }
    if (source === "file") {
      if (csvRows.length === 0) {
        setError("No rows loaded. Please select a CSV file.");
        return null;
      }
      return csvRows;
    }
    // json
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setError("JSON must be a non-empty array.");
        return null;
      }
      const rows: EvalRunRow[] = parsed.map((item: Record<string, string>) => ({
        userInput: String(item.userInput ?? item.user_input ?? ""),
        agentOutput: String(item.agentOutput ?? item.agent_output ?? ""),
        expectedOutput: item.expectedOutput ?? item.expected_output ?? undefined,
        retrievalContext: item.retrievalContext ?? item.retrieval_context ?? undefined,
      }));
      const invalid = rows.find((r) => !r.userInput || !r.agentOutput);
      if (invalid) {
        setError("Each row must have userInput and agentOutput.");
        return null;
      }
      return rows;
    } catch {
      setError("Invalid JSON. Expected an array of objects.");
      return null;
    }
  }

  async function handleSubmit() {
    if (!rubricId) {
      setError("Please select a rubric.");
      return;
    }
    const rows = collectRows();
    if (!rows) return;

    setError(null);
    setSubmitting(true);
    const result = await createEvalRun(rubricId, rows, {
      description: description.trim() || undefined,
      notificationEmails: emails,
      inputSource: source,
    });
    setSubmitting(false);

    if ("error" in result) {
      setError(result.error);
      return;
    }

    onCreated({
      id: result.runId,
      rubricId,
      status: "queued",
      evalType: "tabular",
      description: description.trim() || null,
      notificationEmails: emails,
      overallScore: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative z-10 w-full max-w-2xl h-[90vh] flex flex-col rounded-xl bg-white dark:bg-zinc-900 shadow-xl border border-zinc-200 dark:border-zinc-800 mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <h2 className="text-base font-semibold">Run eval</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none transition-colors"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-6 flex flex-col gap-5">
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {/* Eval rubric */}
          <Field label="Eval rubric">
            <select
              value={rubricId}
              onChange={(e) => setRubricId(e.target.value)}
              className={inputCls}
            >
              {rubrics.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>

          {/* Evaluation type */}
          <Field label="Evaluation type">
            <div className={`${inputCls} text-zinc-400 cursor-not-allowed select-none`}>
              Tabular
            </div>
          </Field>

          {/* Description */}
          <Field label="Description (optional)">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Baseline test — v1.2 agent"
              className={inputCls}
            />
          </Field>

          {/* Notification emails */}
          <Field label="Notification emails (optional)">
            <div className="flex flex-wrap gap-1.5 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 min-h-[38px]">
              {emails.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs"
                >
                  {email}
                  <button
                    type="button"
                    onClick={() => setEmails((prev) => prev.filter((e) => e !== email))}
                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 leading-none"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    commitEmail();
                  }
                }}
                onBlur={commitEmail}
                placeholder={emails.length === 0 ? "you@example.com, then Enter" : ""}
                className="flex-1 min-w-[160px] text-sm outline-none bg-transparent"
              />
            </div>
          </Field>

          {/* Input source */}
          <div>
            <span className="text-sm font-medium block mb-2">Input source</span>
            <div className="flex gap-1 mb-4 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 w-fit">
              {(["file", "manual", "json"] as InputSource[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setSource(tab)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    source === tab
                      ? "bg-white dark:bg-zinc-900 shadow-sm"
                      : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                  }`}
                >
                  {tab === "file" ? "File (CSV)" : tab === "manual" ? "Manual" : "JSON"}
                </button>
              ))}
            </div>

            {source === "file" && (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-zinc-500">
                  CSV must have columns: <code className="font-mono">user_input</code>,{" "}
                  <code className="font-mono">agent_output</code> (optional:{" "}
                  <code className="font-mono">expected_output</code>,{" "}
                  <code className="font-mono">retrieval_context</code>)
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="px-4 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Choose file
                  </button>
                  {csvFileName && (
                    <span className="text-sm text-zinc-500">
                      {csvFileName}{" "}
                      {csvRows.length > 0 && (
                        <span className="text-emerald-600">({csvRows.length} rows)</span>
                      )}
                    </span>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleCsvFile(file);
                  }}
                />
              </div>
            )}

            {source === "manual" && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-1.5 text-xs text-zinc-500 px-1">
                  <span>User input *</span>
                  <span>Agent output *</span>
                  <span>Expected output</span>
                  <span>Retrieval context</span>
                  <span />
                </div>
                {manualRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-1.5 items-start">
                    <textarea
                      rows={2}
                      value={row.userInput}
                      onChange={(e) =>
                        setManualRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, userInput: e.target.value } : r)
                        )
                      }
                      placeholder="User message…"
                      className={`${inputCls} resize-none`}
                    />
                    <textarea
                      rows={2}
                      value={row.agentOutput}
                      onChange={(e) =>
                        setManualRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, agentOutput: e.target.value } : r)
                        )
                      }
                      placeholder="Agent response…"
                      className={`${inputCls} resize-none`}
                    />
                    <textarea
                      rows={2}
                      value={row.expectedOutput ?? ""}
                      onChange={(e) =>
                        setManualRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, expectedOutput: e.target.value } : r)
                        )
                      }
                      placeholder="Optional…"
                      className={`${inputCls} resize-none`}
                    />
                    <textarea
                      rows={2}
                      value={row.retrievalContext ?? ""}
                      onChange={(e) =>
                        setManualRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, retrievalContext: e.target.value } : r)
                        )
                      }
                      placeholder="Optional…"
                      className={`${inputCls} resize-none`}
                    />
                    <button
                      type="button"
                      disabled={manualRows.length === 1}
                      onClick={() =>
                        setManualRows((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="mt-1 text-zinc-400 hover:text-red-500 disabled:opacity-0 transition-colors text-base leading-none"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setManualRows((prev) => [...prev, emptyRow()])}
                  className="self-start text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors mt-1"
                >
                  + Add row
                </button>
              </div>
            )}

            {source === "json" && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-zinc-500">
                  Paste a JSON array with objects containing{" "}
                  <code className="font-mono">userInput</code>,{" "}
                  <code className="font-mono">agentOutput</code> (optional:{" "}
                  <code className="font-mono">expectedOutput</code>,{" "}
                  <code className="font-mono">retrievalContext</code>)
                </p>
                <textarea
                  rows={8}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={`[\n  { "userInput": "…", "agentOutput": "…" }\n]`}
                  className={`${inputCls} font-mono text-xs resize-none`}
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-5 py-2 text-sm font-medium rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors disabled:opacity-50"
          >
            {submitting ? "Queuing…" : "Run eval"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 transition-shadow";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

function parseCsv(text: string): EvalRunRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const normalize = (s: string) =>
    s.trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/\s+/g, "_");

  const headers = lines[0].split(",").map(normalize);

  const colIndex = (names: string[]): number =>
    names.reduce((found, name) => (found >= 0 ? found : headers.indexOf(name)), -1);

  const uiCol = colIndex(["user_input", "userinput", "user"]);
  const aoCol = colIndex(["agent_output", "agentoutput", "agent", "output"]);
  const eoCol = colIndex(["expected_output", "expectedoutput", "expected"]);
  const rcCol = colIndex(["retrieval_context", "retrievalcontext", "context"]);

  if (uiCol < 0 || aoCol < 0) return [];

  const splitLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols = splitLine(line);
      return {
        userInput: cols[uiCol] ?? "",
        agentOutput: cols[aoCol] ?? "",
        expectedOutput: eoCol >= 0 ? cols[eoCol] || undefined : undefined,
        retrievalContext: rcCol >= 0 ? cols[rcCol] || undefined : undefined,
      };
    })
    .filter((r) => r.userInput && r.agentOutput);
}
