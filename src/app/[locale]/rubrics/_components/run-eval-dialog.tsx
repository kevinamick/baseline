"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createEvalRun, type InsufficientPoints } from "@/app/actions/eval-runs";
import { evalRunPointCost } from "@/lib/billing/points";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import { ESTIMATE_JUDGE_MODEL, ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";
import { fmtRate } from "@/lib/billing/format";
import { useManagedEstimatePlan } from "@/app/_components/billing-context";
import { Dialog } from "@/app/_components/dialog";
import { EmailTagsField, useEmailTags } from "@/app/_components/email-tags-field";
import { XIcon } from "@/app/_components/icons";
import { InfoTooltip } from "@/app/_components/info-tooltip";
import { parseCsv } from "./parse-csv";
import { Field } from "./field";
import { EvalRunInputSchema } from "@/lib/validation/schemas";
import { focusFirstError, issuesToInvalidKeys } from "@/lib/validation/focus-first-error";
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

// One definition of "a row that will run" — the cost quote and the submit
// path must count identically, or the dialog quotes a different number than
// the reservation charges.
const isCompleteRow = (r: EvalRunRow): boolean =>
  Boolean(r.userInput.trim() && r.agentOutput.trim());

export function RunEvalDialog({
  rubrics,
  initialRubricId,
  onClose,
  onCreated,
}: Props) {
  // Seeded once per request by BillingProvider (#185); null for BYO/Free Teams.
  const managedEstimatePlan = useManagedEstimatePlan();
  const [rubricId, setRubricId] = useState(initialRubricId ?? rubrics[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const emailTags = useEmailTags();
  const [source, setSource] = useState<InputSource>("manual");
  const [manualRows, setManualRows] = useState<EvalRunRow[]>([emptyRow()]);
  const [jsonText, setJsonText] = useState("");
  const [csvRows, setCsvRows] = useState<EvalRunRow[]>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<InsufficientPoints | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  // The criteria count + the count of rows that will actually run — the single
  // basis the point cost and the managed estimate both derive from, so the two
  // never quote a different row count.
  const { rowCount, criteriaCount } = useMemo(() => {
    const criteria = rubrics.find((r) => r.id === rubricId)?.criteriaCount ?? null;
    let rows = 0;
    if (source === "manual") {
      rows = manualRows.filter(isCompleteRow).length;
    } else if (source === "file") {
      rows = csvRows.length;
    } else {
      try {
        const parsed = JSON.parse(jsonText);
        rows = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        rows = 0;
      }
    }
    return { rowCount: rows, criteriaCount: criteria };
  }, [rubrics, rubricId, source, manualRows, csvRows, jsonText]);

  // Exact pre-run point cost (#180's transparency rule).
  const pointCost =
    criteriaCount == null || rowCount === 0
      ? null
      : evalRunPointCost(rowCount, criteriaCount);

  // Estimated managed token spend (#185), shown only for managed-key Teams. An
  // estimate from a per-model typical-call assumption × markup; the actual charge
  // is metered from real tokens. Null when not on the managed key or unpriceable.
  const managedEstimate =
    managedEstimatePlan == null || criteriaCount == null || rowCount === 0
      ? null
      : estimateManagedSpendUsd(
          managedEstimatePlan,
          ESTIMATE_JUDGE_PROVIDER,
          ESTIMATE_JUDGE_MODEL,
          rowCount,
          criteriaCount
        );

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
      const valid = manualRows.filter(isCompleteRow);
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
    setBlocked(null);
    setSubmitting(true);
    try {
      const result = await createEvalRun(rubricId, rows, {
        description: description.trim() || undefined,
        notificationEmails: finalEmails,
        inputSource: source,
      });

      if ("error" in result) {
        setError(result.error);
        setBlocked(result.insufficientPoints ?? null);
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
          className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-fg-2 transition-colors hover:bg-paper hover:text-ink"
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1 px-6 py-6 flex flex-col gap-5">
        {error && (
          <p role="alert" className="text-sm text-danger-fg">
            {error}
            {blocked && (
              <>
                {" "}
                <Link
                  href="/settings/billing"
                  className="font-medium underline underline-offset-2 hover:text-ink"
                >
                  View usage &amp; billing →
                </Link>
              </>
            )}
          </p>
        )}

        {/* Eval rubric */}
        <Field
          label="Eval rubric"
          htmlFor="run-eval-rubric"
          tooltip="The rubric defines the criteria and scoring methodology for this evaluation. Select the rubric that matches the behavior you want to measure."
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
        <Field label="Evaluation type" htmlFor="run-eval-type" tooltip="Tabular evaluation processes structured rows of user inputs and agent outputs. Each row is scored independently against the selected rubric's criteria.">
          <input
            id="run-eval-type"
            type="text"
            value="Tabular"
            readOnly
            aria-readonly="true"
            className={`${inputCls} text-fg-4 cursor-default select-none`}
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
          <EmailTagsField id="run-eval-email" tags={emailTags} />
        </Field>

        {/* Input source */}
        <div>
          <div className="flex items-center gap-1 mb-2">
            <span id="input-source-label" className="text-sm font-medium">
              Input source
            </span>
            <InfoTooltip content="Choose how to provide the evaluation data: upload a CSV file, enter rows manually, or paste a JSON array. Each row represents one interaction to be scored." />
          </div>
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
                    ? "bg-card text-ink shadow-sm"
                    : "text-fg-3 hover:text-ink"
                }`}
              >
                {tab === "file" ? "File (CSV)" : tab === "manual" ? "Manual" : "JSON"}
              </button>
            ))}
          </div>

          {source === "file" && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-3">
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
                  className={`rounded-full border bg-card px-4 py-2 text-sm transition-colors hover:bg-card-warm ${
                    submitted && csvRows.length === 0
                      ? "border-danger text-danger-fg"
                      : "border-hairline-cool text-ink"
                  }`}
                >
                  Choose file
                </button>
                {csvFileName && (
                  <span className="text-sm text-fg-3">
                    {csvFileName}{" "}
                    {csvRows.length > 0 && (
                      <span className="text-success">({csvRows.length} rows)</span>
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
                    <span className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                      Row {i + 1}
                    </span>
                    <button
                      type="button"
                      disabled={manualRows.length === 1}
                      onClick={() =>
                        setManualRows((prev) => prev.filter((_, j) => j !== i))
                      }
                      aria-label={`Remove row ${i + 1}`}
                      className="text-fg-4 hover:text-danger disabled:opacity-0 disabled:pointer-events-none transition-colors text-base leading-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`user-input-${i}`}
                      className={`text-xs font-medium transition-colors ${rowFieldInvalid(i, "userInput") ? "text-danger-fg" : "text-fg-2 dark:text-fg-4"}`}
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
                      <p className="text-xs text-danger-fg">User input is required</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={`agent-output-${i}`}
                      className={`text-xs font-medium transition-colors ${rowFieldInvalid(i, "agentOutput") ? "text-danger-fg" : "text-fg-2 dark:text-fg-4"}`}
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
                      <p className="text-xs text-danger-fg">Agent output is required</p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1">
                        <label
                          htmlFor={`expected-output-${i}`}
                          className="text-xs font-medium text-fg-3 dark:text-fg-3"
                        >
                          Expected output{" "}
                          <span className="text-fg-4 dark:text-fg-2 font-normal">(optional)</span>
                        </label>
                        <InfoTooltip content="The ideal or reference answer for this input. When provided, the evaluator can compare the agent's actual output against it for accuracy scoring." />
                      </div>
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
                      <div className="flex items-center gap-1">
                        <label
                          htmlFor={`retrieval-context-${i}`}
                          className="text-xs font-medium text-fg-3 dark:text-fg-3"
                        >
                          Retrieval context{" "}
                          <span className="text-fg-4 dark:text-fg-2 font-normal">(optional)</span>
                        </label>
                        <InfoTooltip content="Documents or context retrieved by a RAG system when answering the user's query. Useful for evaluating whether the agent correctly used the retrieved information." />
                      </div>
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
                className="inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
              >
                + Add row
              </button>
            </div>
          )}

          {source === "json" && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-fg-3">
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
        {pointCost != null && (
          <p data-testid="run-point-cost" className="mr-auto text-xs text-fg-3">
            This run will use{" "}
            <span className="font-mono font-semibold text-fg-2">
              {pointCost.toLocaleString("en-US")}
            </span>{" "}
            Eval Points
            {managedEstimate != null && (
              <span data-testid="run-managed-estimate">
                {" · ~"}
                <span className="font-mono font-semibold text-fg-2">
                  {fmtRate(managedEstimate)}
                </span>{" "}
                est. managed spend
              </span>
            )}
          </p>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          aria-disabled={submitting}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink"
        >
          {submitting ? "Queuing…" : "Run eval"}
        </button>
      </div>
    </Dialog>
  );
}

const baseCls =
  "w-full rounded-md bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition";

const validBorderCls =
  "border border-hairline-field focus:border-accent focus:ring-[3px] focus:ring-accent/50";

const invalidBorderCls =
  "border border-danger focus:border-danger focus:ring-[3px] focus:ring-red-400/30";

const inputCls = `${baseCls} ${validBorderCls}`;
