"use client";

import { useRef, useState } from "react";
import { createEvalRun } from "@/app/actions/eval-runs";
import { Dialog } from "@/app/_components/dialog";
import { EmailTagsField, useEmailTags } from "@/app/_components/email-tags-field";
import { XIcon } from "@/app/_components/icons";
import { parseCsv } from "./parse-csv";
import { Field } from "./field";
import { EvalRunInputSchema } from "@/lib/validation/schemas";
import { focusFirstError, issuesToInvalidKeys } from "@/lib/validation/focus-first-error";
import type { EvalRun, EvalRunRow } from "@/types/eval-run";
import type { RubricSummary } from "@/types/rubric";
import type { EmailGroup } from "@/types/email-group";

type InputSource = "file" | "manual" | "json";

interface Props {
  rubrics: RubricSummary[];
  initialRubricId: string | null;
  emailGroups?: EmailGroup[];
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
  emailGroups = [],
  onClose,
  onCreated,
}: Props) {
  const [rubricId, setRubricId] = useState(initialRubricId ?? rubrics[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const emailTags = useEmailTags();
  const [source, setSource] = useState<InputSource>("manual");
  const [manualRows, setManualRows] = useState<EvalRunRow[]>([emptyRow()]);
  const [jsonText, setJsonText] = useState("");
  const [csvRows, setCsvRows] = useState<EvalRunRow[]>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  function rowFieldInvalid(i: number, field: "userInput" | "agentOutput") {
    return invalidKeys.has(`rows.${i}.${field}`);
  }

  function clearInvalid(key: string) {
    setInvalidKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function handleCsvFile(file: File) {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCsv(text);
      setCsvRows(parsed);
      setError(
        parsed.length === 0
          ? "Could not parse CSV. Expected columns: user_input, agent_output (optional: expected_output, retrieval_context)"
          : null
      );
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
    setSubmitted(true);

    if (source === "manual") {
      const result = EvalRunInputSchema.safeParse({ rubricId, rows: manualRows });
      if (!result.success) {
        const keys = issuesToInvalidKeys(result.error);
        setInvalidKeys(keys);
        setError(null);
        const ids: string[] = [];
        if (keys.has("rubricId")) ids.push("run-eval-rubric");
        manualRows.forEach((_, i) => {
          if (keys.has(`rows.${i}.userInput`)) ids.push(`user-input-${i}`);
          if (keys.has(`rows.${i}.agentOutput`)) ids.push(`agent-output-${i}`);
        });
        focusFirstError(ids);
        return;
      }
      setInvalidKeys(new Set());
    } else if (!rubricId) {
      setError("Select a rubric.");
      focusFirstError(["run-eval-rubric"]);
      return;
    }

    const rows = collectRows();
    if (!rows) {
      if (source === "file") focusFirstError(["run-eval-file-button"]);
      if (source === "json") focusFirstError(["run-eval-json"]);
      return;
    }

    // resolve() includes any address still in the input box that the user typed
    // but didn't commit via Enter/comma before clicking submit.
    const finalEmails = emailTags.resolve();

    setError(null);
    setSubmitting(true);
    try {
      const result = await createEvalRun(rubricId, rows, {
        description: description.trim() || undefined,
        notificationEmails: finalEmails,
        inputSource: source,
      });

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
        notificationEmails: finalEmails,
        overallScore: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
      });
      onClose();
    } catch {
      setError("Couldn't start the eval run. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      ariaLabelledBy="run-eval-dialog-title"
      className="max-w-2xl h-[90vh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-6 py-4">
        <h2
          id="run-eval-dialog-title"
          className="text-lg font-semibold tracking-[-0.015em]"
        >
          Run eval
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-zinc-600 transition-colors hover:bg-paper hover:text-ink"
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1 px-6 py-6 flex flex-col gap-5">
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {/* Eval rubric */}
        <Field
          label="Eval rubric"
          htmlFor="run-eval-rubric"
          error={invalidKeys.has("rubricId") ? "Select a rubric" : undefined}
        >
          <select
            id="run-eval-rubric"
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
        <Field label="Evaluation type" htmlFor="run-eval-type">
          <input
            id="run-eval-type"
            type="text"
            value="Tabular"
            readOnly
            aria-readonly="true"
            className={`${inputCls} text-zinc-400 cursor-default select-none`}
          />
        </Field>

        {/* Description */}
        <Field label="Description" htmlFor="run-eval-description" optional>
          <input
            id="run-eval-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Baseline test — v1.2 agent"
            className={inputCls}
          />
        </Field>

        {/* Notification emails */}
        <Field label="Notification emails" htmlFor="run-eval-email" optional>
          {emailGroups.length > 0 && (
            <select
              aria-label="Apply email group"
              className={`${inputCls} mb-2`}
              value=""
              onChange={(e) => {
                const group = emailGroups.find((g) => g.id === e.target.value);
                if (group) emailTags.add(group.emails);
              }}
            >
              <option value="" disabled>Apply email group…</option>
              {emailGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <EmailTagsField id="run-eval-email" tags={emailTags} />
        </Field>

        {/* Input source */}
        <div>
          <span id="input-source-label" className="text-sm font-medium block mb-2">
            Input source
          </span>
          <div
            role="tablist"
            aria-labelledby="input-source-label"
            className="mb-4 flex w-fit gap-1 rounded-lg bg-paper-warm p-1"
          >
            {(["file", "manual", "json"] as InputSource[]).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={source === tab}
                onClick={() => { setSource(tab); setSubmitted(false); setInvalidKeys(new Set()); setError(null); }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  source === tab
                    ? "bg-white text-ink shadow-sm"
                    : "text-zinc-500 hover:text-ink"
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
                  id="run-eval-file-button"
                  onClick={() => fileRef.current?.click()}
                  className={`rounded-full border bg-white px-4 py-2 text-sm transition-colors hover:bg-card-warm ${
                    submitted && csvRows.length === 0
                      ? "border-red-400 text-red-600"
                      : "border-hairline-cool text-ink"
                  }`}
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
                aria-label="Upload CSV file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCsvFile(file);
                }}
              />
            </div>
          )}

          {source === "manual" && (
            <div className="flex flex-col gap-3">
              {manualRows.map((row, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-3 rounded-lg border border-hairline bg-card-warm p-4"
                >
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Row {i + 1}
                    </span>
                    <button
                      type="button"
                      disabled={manualRows.length === 1}
                      onClick={() =>
                        setManualRows((prev) => prev.filter((_, j) => j !== i))
                      }
                      aria-label={`Remove row ${i + 1}`}
                      className="text-zinc-400 hover:text-red-500 disabled:opacity-0 disabled:pointer-events-none transition-colors text-base leading-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`user-input-${i}`}
                      className={`text-xs font-medium transition-colors ${rowFieldInvalid(i, "userInput") ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"}`}
                    >
                      User input
                    </label>
                    <textarea
                      id={`user-input-${i}`}
                      rows={3}
                      aria-required="true"
                      aria-invalid={rowFieldInvalid(i, "userInput")}
                      value={row.userInput}
                      onChange={(e) => {
                        setManualRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, userInput: e.target.value } : r)
                        );
                        clearInvalid(`rows.${i}.userInput`);
                      }}
                      placeholder="What the user said…"
                      className={`${baseCls} resize-none ${rowFieldInvalid(i, "userInput") ? invalidBorderCls : validBorderCls}`}
                    />
                    {rowFieldInvalid(i, "userInput") && (
                      <p className="text-xs text-red-600 dark:text-red-400">User input is required</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`agent-output-${i}`}
                      className={`text-xs font-medium transition-colors ${rowFieldInvalid(i, "agentOutput") ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"}`}
                    >
                      Agent output
                    </label>
                    <textarea
                      id={`agent-output-${i}`}
                      rows={3}
                      aria-required="true"
                      aria-invalid={rowFieldInvalid(i, "agentOutput")}
                      value={row.agentOutput}
                      onChange={(e) => {
                        setManualRows((prev) =>
                          prev.map((r, j) => j === i ? { ...r, agentOutput: e.target.value } : r)
                        );
                        clearInvalid(`rows.${i}.agentOutput`);
                      }}
                      placeholder="What the agent responded…"
                      className={`${baseCls} resize-none ${rowFieldInvalid(i, "agentOutput") ? invalidBorderCls : validBorderCls}`}
                    />
                    {rowFieldInvalid(i, "agentOutput") && (
                      <p className="text-xs text-red-600 dark:text-red-400">Agent output is required</p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={`expected-output-${i}`}
                        className="text-xs font-medium text-zinc-500 dark:text-zinc-500"
                      >
                        Expected output{" "}
                        <span className="text-zinc-400 dark:text-zinc-600 font-normal">(optional)</span>
                      </label>
                      <textarea
                        id={`expected-output-${i}`}
                        rows={2}
                        value={row.expectedOutput ?? ""}
                        onChange={(e) =>
                          setManualRows((prev) =>
                            prev.map((r, j) => j === i ? { ...r, expectedOutput: e.target.value } : r)
                          )
                        }
                        placeholder="Ideal answer…"
                        className={`${inputCls} resize-none`}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={`retrieval-context-${i}`}
                        className="text-xs font-medium text-zinc-500 dark:text-zinc-500"
                      >
                        Retrieval context{" "}
                        <span className="text-zinc-400 dark:text-zinc-600 font-normal">(optional)</span>
                      </label>
                      <textarea
                        id={`retrieval-context-${i}`}
                        rows={2}
                        value={row.retrievalContext ?? ""}
                        onChange={(e) =>
                          setManualRows((prev) =>
                            prev.map((r, j) => j === i ? { ...r, retrievalContext: e.target.value } : r)
                          )
                        }
                        placeholder="Retrieved docs…"
                        className={`${inputCls} resize-none`}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setManualRows((prev) => [...prev, emptyRow()])}
                className="inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-white px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
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
                id="run-eval-json"
                rows={8}
                aria-label="JSON input array"
                aria-invalid={submitted && !jsonText.trim()}
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder={`[\n  { "userInput": "…", "agentOutput": "…" }\n]`}
                className={`${baseCls} font-mono text-xs resize-none ${submitted && !jsonText.trim() ? invalidBorderCls : validBorderCls}`}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-hairline bg-paper-warm px-6 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          aria-disabled={submitting}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink"
        >
          {submitting ? "Queuing…" : "Run eval"}
        </button>
      </div>
    </Dialog>
  );
}

const baseCls =
  "w-full rounded-md bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition";

const validBorderCls =
  "border border-hairline-field focus:border-accent focus:ring-[3px] focus:ring-accent/40";

const invalidBorderCls =
  "border border-red-400 focus:border-red-500 focus:ring-[3px] focus:ring-red-400/30";

const inputCls = `${baseCls} ${validBorderCls}`;
