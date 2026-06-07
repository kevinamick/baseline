"use client";

import { useRef, useState } from "react";
import { Dialog } from "@/app/_components/dialog";
import { XIcon } from "@/app/_components/icons";
import { Field } from "@/app/rubrics/_components/field";
import { startOptimizationRun } from "@/app/actions/optimizations";
import { REFLECT_MODELS, DEFAULT_REFLECT_MODEL } from "@/lib/optimization/models";
import { parseInstancesCsv, parseInstancesJson } from "@/lib/optimization/parse-instances";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";
import { isAllowedEndpointUrl, ENDPOINT_HTTPS_MESSAGE } from "@/lib/connections/endpoint";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection, OptimizationInstanceRow } from "@/types/optimization";

interface ModuleRow {
  name: string;
  seed: string;
}

const MODULE_NAME_RE = /^[A-Za-z0-9_-]+$/;

const DEFAULT_REQUEST_TEMPLATE = `{
  "input": "{{user_input}}",
  "system": "{{prompt:system}}"
}`;

// Inject "<name>": "{{prompt:<name>}}" into a JSON-object request template so a newly added
// Module is referenced out of the box (keeps declared↔referenced in sync). A hand-edited or
// non-object template is left untouched — the live cross-validation hint then guides the user.
function withModuleRef(template: string, name: string): string {
  try {
    const obj = JSON.parse(template);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      (obj as Record<string, unknown>)[name] = `{{prompt:${name}}}`;
      return JSON.stringify(obj, null, 2);
    }
  } catch {
    /* leave a hand-edited template as-is */
  }
  return template;
}

// A fresh, unused Module name for the "+ Add Module" action — so the auto-injected placeholder
// is unique and immediately valid.
function nextModuleName(existing: ModuleRow[]): string {
  const used = new Set(existing.map((m) => m.name.trim()).filter(Boolean));
  for (const candidate of ["style", "tone", "format", "persona", "context"]) {
    if (!used.has(candidate)) return candidate;
  }
  let i = existing.length + 1;
  while (used.has(`module${i}`)) i++;
  return `module${i}`;
}

interface Props {
  rubrics: RubricSummary[];
  connections: OptimizableConnection[];
  onClose: () => void;
  onCreated: () => void;
}

const STEP = {
  basics: "Basics",
  system: "System",
  instances: "Instances",
  tuning: "Tuning",
  review: "Review",
} as const;

const STEPS = [STEP.basics, STEP.system, STEP.instances, STEP.tuning, STEP.review];

// Defaults: budget is the one knob a user must think about (it's spend); the rest live under
// Advanced with GEPA-sane defaults (D8/D9).
const DEFAULT_BUDGET = 30;
const DEFAULT_MAX_ITERS = 20;
const DEFAULT_PLATEAU = 5;
const MAX_INSTANCES = 50;

type InstanceSource = "manual" | "file" | "json";

const emptyRow = (): OptimizationInstanceRow => ({
  userInput: "",
  expectedOutput: "",
  retrievalContext: "",
});

// Parse a number-input value to a non-negative integer, mapping blank/NaN to 0 so per-field
// validation fires instead of NaN reaching Review or the server.
function toCount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function OptimizationWizard({ rubrics, connections, onClose, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"right" | "left">("right");
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Basics
  const [rubricId, setRubricId] = useState(rubrics[0]?.id ?? "");

  // System — either an existing agent Connection or one created inline (#108).
  const [connMode, setConnMode] = useState<"existing" | "new">(
    connections.length ? "existing" : "new"
  );
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  // Inline new-connection fields (agent-only — datasets can't be optimized).
  const [connName, setConnName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [requestTemplate, setRequestTemplate] = useState(DEFAULT_REQUEST_TEMPLATE);
  const [responsePath, setResponsePath] = useState("output");
  const [modules, setModules] = useState<ModuleRow[]>([{ name: "system", seed: "" }]);

  // Instances (tri-source)
  const [instanceSource, setInstanceSource] = useState<InstanceSource>("manual");
  const [manualRows, setManualRows] = useState<OptimizationInstanceRow[]>([emptyRow()]);
  const [importedRows, setImportedRows] = useState<OptimizationInstanceRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  // Monotonic upload id so a slow earlier CSV decode can't overwrite a newer one out of order.
  const uploadSeq = useRef(0);

  // Tuning
  const [budgetRollouts, setBudgetRollouts] = useState(DEFAULT_BUDGET);
  const [maxIters, setMaxIters] = useState(DEFAULT_MAX_ITERS);
  const [plateauPatience, setPlateauPatience] = useState(DEFAULT_PLATEAU);
  const [reflectModel, setReflectModel] = useState<string>(DEFAULT_REFLECT_MODEL);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const stepName = STEPS[step];
  const selectedRubric = rubrics.find((r) => r.id === rubricId);
  const selectedConnection = connections.find((c) => c.id === connectionId);

  // Resolve the active instance source to cleaned, submit-ready rows (optional fields → null),
  // or an error message for the step. Used by both validation and submit so they never diverge.
  function resolveInstances():
    | { rows: { userInput: string; expectedOutput: string | null; retrievalContext: string | null }[]; error: null }
    | { rows: null; error: string } {
    let raw: OptimizationInstanceRow[];
    if (instanceSource === "manual") {
      raw = manualRows.filter((r) => r.userInput.trim());
      if (raw.length === 0) return { rows: null, error: "Add at least one input row." };
    } else if (instanceSource === "file") {
      if (importedRows.length === 0) return { rows: null, error: "Upload a CSV with a user_input column." };
      raw = importedRows;
    } else {
      if (!jsonText.trim()) return { rows: null, error: "Paste a JSON array of instances." };
      try {
        raw = parseInstancesJson(jsonText);
      } catch {
        return { rows: null, error: "Instances must be a valid JSON array of objects." };
      }
      if (raw.length === 0) return { rows: null, error: "No instances with a user_input were found." };
    }

    if (raw.length > MAX_INSTANCES) {
      return { rows: null, error: `Up to ${MAX_INSTANCES} instances (got ${raw.length}).` };
    }

    return {
      rows: raw.map((r) => ({
        userInput: r.userInput.trim(),
        expectedOutput: r.expectedOutput.trim() || null,
        retrievalContext: r.retrievalContext.trim() || null,
      })),
      error: null,
    };
  }

  // Count shown on Review = exactly what will be submitted (a single source of truth: the same
  // resolveInstances() the submit uses). Falls back to 0 when the active source isn't valid yet.
  function instanceCount(): number {
    return resolveInstances().rows?.length ?? 0;
  }

  // Live declared↔referenced cross-check for the inline new Connection: which declared Modules
  // are missing a {{prompt:name}} reference, and which references have no declared Module. Drives
  // both the inline hint and the step validation, so the wizard can't launch a mismatch (#108).
  const declaredModuleNames = modules.map((m) => m.name.trim()).filter(Boolean);
  const referencedModuleNames = extractPromptRefs(requestTemplate);
  const missingRefs = declaredModuleNames.filter((n) => !referencedModuleNames.includes(n));
  const undeclaredRefs = referencedModuleNames.filter((n) => !declaredModuleNames.includes(n));

  function newConnectionError(): string | null {
    if (!connName.trim()) return "Name the connection.";
    if (!isAllowedEndpointUrl(endpoint)) return ENDPOINT_HTTPS_MESSAGE;
    try {
      JSON.parse(requestTemplate);
    } catch {
      return "Request template must be valid JSON.";
    }
    if (!responsePath.trim()) return "Enter the response path.";
    if (authValue.trim() && !authHeader.trim()) {
      return "Add an auth header name for the auth value (e.g. Authorization).";
    }
    // A row with a seed but no name would be silently dropped at submit — flag it instead.
    if (modules.some((m) => !m.name.trim() && m.seed.trim())) {
      return "Give every Module a name (or clear the empty row).";
    }
    const named = modules.filter((m) => m.name.trim());
    if (named.length === 0) return "Declare at least one Module.";
    for (const m of named) {
      if (!MODULE_NAME_RE.test(m.name.trim())) {
        return `Module name "${m.name.trim()}" — use letters, digits, hyphens, or underscores.`;
      }
      if (!m.seed.trim()) return `Give Module "${m.name.trim()}" a seed prompt.`;
    }
    if (new Set(named.map((m) => m.name.trim())).size !== named.length) {
      return "Module names must be unique.";
    }
    if (missingRefs.length > 0) {
      return `Declared Module "${missingRefs[0]}" must be referenced as {{prompt:${missingRefs[0]}}} in the request template.`;
    }
    if (undeclaredRefs.length > 0) {
      return `Request template references {{prompt:${undeclaredRefs[0]}}} but no Module "${undeclaredRefs[0]}" is declared.`;
    }
    return null;
  }

  function buildNewConnection() {
    return {
      type: "agent" as const,
      name: connName.trim(),
      endpoint: endpoint.trim(),
      authHeader: authHeader.trim() || null,
      // Trim to match the schema's auth-header rule (a whitespace-only value would otherwise
      // pass the client check but trip the server's "value needs a header" refine).
      authValue: authValue.trim() || null,
      requestTemplate,
      responsePath: responsePath.trim(),
      optimizablePrompts: modules
        .filter((m) => m.name.trim())
        .map((m) => ({ name: m.name.trim(), seed: m.seed.trim() })),
    };
  }

  function validateStep(s: string): string | null {
    if (s === STEP.basics && !rubricId) return "Select a rubric.";
    if (s === STEP.system) {
      if (connMode === "existing") {
        if (!connectionId) return "Select an agent connection.";
      } else {
        return newConnectionError();
      }
    }
    if (s === STEP.instances) {
      const { error } = resolveInstances();
      if (error) return error;
    }
    if (s === STEP.tuning) {
      if (!budgetRollouts || budgetRollouts <= 0) return "Set a rollout budget (1 or more).";
      if (budgetRollouts > 2000) return "Rollout budget can't exceed 2000.";
      if (!maxIters || maxIters <= 0) return "Max iterations must be 1 or more.";
      if (maxIters > 200) return "Max iterations can't exceed 200.";
    }
    return null;
  }

  function goNext() {
    const err = validateStep(stepName);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setDirection("right");
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setStepError(null);
    setDirection("left");
    setStep((s) => Math.max(s - 1, 0));
  }

  function onFile(file: File) {
    const seq = ++uploadSeq.current;
    setFileName(file.name);
    void file.text().then((text) => {
      // A newer upload started while this one decoded — drop this stale result.
      if (seq !== uploadSeq.current) return;
      const rows = parseInstancesCsv(text);
      setImportedRows(rows);
      setFileNote(
        rows.length > 0
          ? `${rows.length} instance${rows.length === 1 ? "" : "s"} loaded`
          : "No rows found — the CSV needs a user_input column."
      );
    });
  }

  async function handleSubmit() {
    const resolved = resolveInstances();
    if (resolved.rows === null) {
      // Send the user back to the Instances step rather than failing opaquely on Review.
      setStep(STEPS.indexOf(STEP.instances));
      setStepError(resolved.error);
      return;
    }

    const usingNew = connMode === "new";
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await startOptimizationRun({
        // Exactly one of the two — the schema enforces the xor.
        connectionId: usingNew ? undefined : connectionId,
        newConnection: usingNew ? buildNewConnection() : undefined,
        rubricId,
        evalType: "tabular",
        instances: resolved.rows,
        budgetRollouts,
        maxIters,
        // 0 (the toCount of a cleared field) means "no plateau early-stop".
        plateauPatience: plateauPatience > 0 ? plateauPatience : null,
        reflectModel,
      });
      if ("error" in result) {
        setSubmitError(result.error);
        return;
      }
      onCreated();
      onClose();
    } catch {
      setSubmitError("Couldn't start the optimization run. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onClose={onClose} ariaLabelledBy="opt-wizard-title" className="max-w-2xl h-[90vh]">
      {/* Header + step progress */}
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 id="opt-wizard-title" className="text-lg font-semibold tracking-[-0.015em]">
            New optimization run
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
        <ol className="mt-4 flex items-center gap-1.5">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium transition-colors ${
                  i === step
                    ? "bg-ink text-white"
                    : i < step
                      ? "bg-accent-soft text-accent-ink"
                      : "bg-paper-warm text-zinc-500"
                }`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && <span className="text-zinc-300">·</span>}
            </li>
          ))}
        </ol>
      </div>

      {/* Body — only the active step is rendered, animated by direction */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div key={step} className={direction === "right" ? "wizard-in-right" : "wizard-in-left"}>
          {stepError && (
            <p role="alert" className="mb-4 text-sm text-red-600">
              {stepError}
            </p>
          )}

          {stepName === STEP.basics && (
            <div className="flex flex-col gap-5">
              <Field label="Rubric" htmlFor="opt-rubric">
                <select
                  id="opt-rubric"
                  value={rubricId}
                  onChange={(e) => setRubricId(e.target.value)}
                  className={inputCls}
                >
                  {rubrics.length === 0 && <option value="">No rubrics yet</option>}
                  {rubrics.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-xs text-zinc-500">
                The rubric scores each rollout. Its per-criterion reasoning is the textual feedback
                the reflection model learns from.
              </p>
              <Field label="Evaluation type" htmlFor="opt-type">
                <input
                  id="opt-type"
                  type="text"
                  value="Tabular"
                  readOnly
                  aria-readonly="true"
                  className={`${inputCls} text-zinc-400 cursor-default select-none`}
                />
              </Field>
            </div>
          )}

          {stepName === STEP.system && (
            <div className="flex flex-col gap-5">
              {connections.length > 0 && (
                <div className="flex w-fit gap-1 rounded-lg bg-paper-warm p-1">
                  {(["existing", "new"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setConnMode(m);
                        setStepError(null);
                      }}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                        connMode === m ? "bg-white text-ink shadow-sm" : "text-zinc-500 hover:text-ink"
                      }`}
                    >
                      {m === "existing" ? "Use existing" : "New connection"}
                    </button>
                  ))}
                </div>
              )}

              {connMode === "existing" ? (
                <>
                  <Field label="Agent connection" htmlFor="opt-conn">
                    <select
                      id="opt-conn"
                      value={connectionId}
                      onChange={(e) => setConnectionId(e.target.value)}
                      className={inputCls}
                    >
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} — {c.modules.length} module{c.modules.length === 1 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {selectedConnection && (
                    <p className="text-xs text-zinc-500">
                      Modules tuned:{" "}
                      {selectedConnection.modules.map((m) => (
                        <code key={m} className="mr-1 font-mono text-[11px] text-ink">
                          {m}
                        </code>
                      ))}
                    </p>
                  )}
                </>
              ) : (
                <NewConnectionForm
                  connName={connName}
                  setConnName={setConnName}
                  endpoint={endpoint}
                  setEndpoint={setEndpoint}
                  authHeader={authHeader}
                  setAuthHeader={setAuthHeader}
                  authValue={authValue}
                  setAuthValue={setAuthValue}
                  requestTemplate={requestTemplate}
                  setRequestTemplate={setRequestTemplate}
                  responsePath={responsePath}
                  setResponsePath={setResponsePath}
                  modules={modules}
                  setModules={setModules}
                  missingRefs={missingRefs}
                  undeclaredRefs={undeclaredRefs}
                />
              )}
            </div>
          )}

          {stepName === STEP.instances && (
            <InstancesStep
              source={instanceSource}
              setSource={(s) => {
                setInstanceSource(s);
                setStepError(null);
              }}
              manualRows={manualRows}
              setManualRows={setManualRows}
              fileName={fileName}
              fileNote={fileNote}
              onFile={onFile}
              jsonText={jsonText}
              setJsonText={setJsonText}
            />
          )}

          {stepName === STEP.tuning && (
            <div className="flex flex-col gap-5">
              <Field label="Rollout budget" htmlFor="opt-budget">
                <input
                  id="opt-budget"
                  type="number"
                  min={1}
                  max={2000}
                  value={budgetRollouts}
                  onChange={(e) => setBudgetRollouts(toCount(e.target.value))}
                  className={inputCls}
                />
              </Field>
              <p className="text-xs text-zinc-500">
                Each rollout is one live call to your agent endpoint, so the budget is your cost
                ceiling — a budget of <span className="font-medium text-ink">{budgetRollouts}</span>{" "}
                means up to {budgetRollouts} agent calls before the run stops and returns the best
                prompt found.
              </p>

              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="self-start text-xs font-medium text-accent-ink hover:underline"
              >
                {showAdvanced ? "Hide advanced" : "Advanced settings"}
              </button>

              {showAdvanced && (
                <div className="flex flex-col gap-5 rounded-lg border border-hairline bg-card-warm p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Max iterations" htmlFor="opt-maxiters">
                      <input
                        id="opt-maxiters"
                        type="number"
                        min={1}
                        max={200}
                        value={maxIters}
                        onChange={(e) => setMaxIters(toCount(e.target.value))}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Plateau patience" htmlFor="opt-plateau">
                      <input
                        id="opt-plateau"
                        type="number"
                        min={0}
                        value={plateauPatience}
                        onChange={(e) => setPlateauPatience(toCount(e.target.value))}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                  <p className="text-xs text-zinc-500">
                    The run also stops after Max iterations, or after Plateau patience iterations
                    with no frontier gain (set 0 to disable the early-stop).
                  </p>
                  <Field label="Reflection model" htmlFor="opt-model">
                    <select
                      id="opt-model"
                      value={reflectModel}
                      onChange={(e) => setReflectModel(e.target.value)}
                      className={inputCls}
                    >
                      {REFLECT_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
            </div>
          )}

          {stepName === STEP.review && (
            <div className="flex flex-col gap-3">
              {submitError && (
                <p role="alert" className="text-sm text-red-600">
                  {submitError}
                </p>
              )}
              <ReviewRow label="Rubric" value={selectedRubric?.name ?? "—"} />
              <ReviewRow
                label="Agent"
                value={
                  connMode === "new"
                    ? `${connName.trim() || "New agent"} (new connection)`
                    : selectedConnection?.name ?? "—"
                }
              />
              <ReviewRow
                label="Modules"
                value={
                  connMode === "new"
                    ? declaredModuleNames.join(", ") || "—"
                    : selectedConnection?.modules.join(", ") || "—"
                }
              />
              <ReviewRow label="Instances" value={`${instanceCount()} row(s)`} />
              <ReviewRow label="Rollout budget" value={`${budgetRollouts} agent call(s)`} />
              <ReviewRow label="Max iterations" value={String(maxIters)} />
              <ReviewRow
                label="Plateau patience"
                value={plateauPatience > 0 ? String(plateauPatience) : "Off"}
              />
              <ReviewRow
                label="Reflection model"
                value={REFLECT_MODELS.find((m) => m.id === reflectModel)?.label ?? reflectModel}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-paper-warm px-6 py-3.5">
        <button
          type="button"
          onClick={goBack}
          disabled={step === 0}
          className="rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm disabled:opacity-40 disabled:hover:bg-white"
        >
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            onClick={goNext}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Starting…" : "Start run"}
          </button>
        )}
      </div>
    </Dialog>
  );
}

// The tri-source instance ingester: manual rows, CSV upload, or JSON paste. Optimization
// instances need only user_input (no agent_output — the agent runs live).
function InstancesStep({
  source,
  setSource,
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
  manualRows: OptimizationInstanceRow[];
  setManualRows: React.Dispatch<React.SetStateAction<OptimizationInstanceRow[]>>;
  fileName: string;
  fileNote: string | null;
  onFile: (file: File) => void;
  jsonText: string;
  setJsonText: (v: string) => void;
}) {
  const SOURCES: { id: InstanceSource; label: string }[] = [
    { id: "manual", label: "Manual" },
    { id: "file", label: "CSV file" },
    { id: "json", label: "JSON" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-fit gap-1 rounded-lg bg-paper-warm p-1">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSource(s.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              source === s.id ? "bg-white text-ink shadow-sm" : "text-zinc-500 hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-zinc-500">
        These inputs are frozen at run start; every candidate prompt is scored on the same set.
        Only <code className="font-mono">user_input</code> is required —{" "}
        <code className="font-mono">expected_output</code> and{" "}
        <code className="font-mono">retrieval_context</code> are optional.
      </p>

      {source === "manual" && (
        <div className="flex flex-col gap-3">
          {manualRows.map((row, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-lg border border-hairline bg-card-warm p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Input {i + 1}
                </span>
                <button
                  type="button"
                  disabled={manualRows.length === 1}
                  onClick={() => setManualRows((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove input ${i + 1}`}
                  className="text-base leading-none text-zinc-400 transition-colors hover:text-red-500 disabled:pointer-events-none disabled:opacity-0"
                >
                  ×
                </button>
              </div>
              <textarea
                rows={2}
                value={row.userInput}
                onChange={(e) =>
                  setManualRows((prev) =>
                    prev.map((r, j) => (j === i ? { ...r, userInput: e.target.value } : r))
                  )
                }
                placeholder="User input…"
                className={`${inputCls} resize-none`}
              />
              <div className="grid grid-cols-2 gap-3">
                <textarea
                  rows={2}
                  value={row.expectedOutput}
                  onChange={(e) =>
                    setManualRows((prev) =>
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
                    setManualRows((prev) =>
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
            onClick={() =>
              setManualRows((prev) => [...prev, { userInput: "", expectedOutput: "", retrievalContext: "" }])
            }
            className="inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-white px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
          >
            + Add input
          </button>
        </div>
      )}

      {source === "file" && (
        <div className="flex flex-col gap-2">
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm">
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
            <p className="text-xs text-zinc-500">
              <span className="font-medium text-ink">{fileName}</span>
              {fileNote ? ` — ${fileNote}` : ""}
            </p>
          )}
          <p className="text-xs text-zinc-400">
            Header row with a <code className="font-mono">user_input</code> column (optionally{" "}
            <code className="font-mono">expected_output</code>,{" "}
            <code className="font-mono">retrieval_context</code>).
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
          <p className="text-xs text-zinc-400">
            An array of objects, each with <code className="font-mono">user_input</code> (optionally{" "}
            <code className="font-mono">expected_output</code>,{" "}
            <code className="font-mono">retrieval_context</code>).
          </p>
        </div>
      )}
    </div>
  );
}

// Inline agent-Connection form (agent-only — datasets can't be optimized). Declares the
// {{prompt:*}} Modules to tune and cross-checks them against the request template live, so a
// declared↔referenced mismatch is caught here, not at launch (#108).
function NewConnectionForm({
  connName,
  setConnName,
  endpoint,
  setEndpoint,
  authHeader,
  setAuthHeader,
  authValue,
  setAuthValue,
  requestTemplate,
  setRequestTemplate,
  responsePath,
  setResponsePath,
  modules,
  setModules,
  missingRefs,
  undeclaredRefs,
}: {
  connName: string;
  setConnName: (v: string) => void;
  endpoint: string;
  setEndpoint: (v: string) => void;
  authHeader: string;
  setAuthHeader: (v: string) => void;
  authValue: string;
  setAuthValue: (v: string) => void;
  requestTemplate: string;
  setRequestTemplate: (v: string) => void;
  responsePath: string;
  setResponsePath: (v: string) => void;
  modules: ModuleRow[];
  setModules: React.Dispatch<React.SetStateAction<ModuleRow[]>>;
  missingRefs: string[];
  undeclaredRefs: string[];
}) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-zinc-500">
        Baseline calls your agent once per rollout. Reference each Module as{" "}
        <code className="font-mono">{"{{prompt:<name>}}"}</code> in the request body alongside{" "}
        <code className="font-mono">{"{{user_input}}"}</code>; the response path locates the
        agent&apos;s output. The new connection is saved and reusable.
      </p>

      <Field label="Connection name" htmlFor="newconn-name">
        <input
          id="newconn-name"
          type="text"
          value={connName}
          onChange={(e) => setConnName(e.target.value)}
          placeholder="e.g. Support agent (prod)"
          className={inputCls}
        />
      </Field>

      <Field label="Endpoint URL" htmlFor="newconn-endpoint">
        <input
          id="newconn-endpoint"
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://api.example.com/agent"
          className={inputCls}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Auth header" htmlFor="newconn-auth-header" optional>
          <input
            id="newconn-auth-header"
            type="text"
            value={authHeader}
            onChange={(e) => setAuthHeader(e.target.value)}
            placeholder="Authorization"
            className={inputCls}
          />
        </Field>
        <Field label="Auth value" htmlFor="newconn-auth-value" optional>
          <input
            id="newconn-auth-value"
            type="password"
            value={authValue}
            onChange={(e) => setAuthValue(e.target.value)}
            placeholder="Bearer sk-…"
            className={inputCls}
          />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-zinc-500">
        Credentials are encrypted at rest and in transit, never exposed to the browser, and
        decrypted only server-side when Baseline calls your agent.
      </p>

      {/* Modules editor */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-ink">Modules</span>
          <button
            type="button"
            onClick={() => {
              // Add the Module AND reference it in the request template, so it's valid out of
              // the box instead of immediately tripping the declared↔referenced check.
              const name = nextModuleName(modules);
              setModules((prev) => [...prev, { name, seed: "" }]);
              setRequestTemplate(withModuleRef(requestTemplate, name));
            }}
            className="rounded-full border border-hairline-cool bg-white px-3 py-1 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
          >
            + Add Module
          </button>
        </div>
        {modules.map((mod, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-hairline bg-card-warm p-3">
            <div className="flex items-center gap-2">
              <input
                aria-label={`Module ${i + 1} name`}
                type="text"
                value={mod.name}
                onChange={(e) =>
                  setModules((prev) => prev.map((m, j) => (j === i ? { ...m, name: e.target.value } : m)))
                }
                placeholder="module name (e.g. system)"
                className={`${inputCls} font-mono text-xs`}
              />
              <button
                type="button"
                disabled={modules.length === 1}
                onClick={() => setModules((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove Module ${i + 1}`}
                className="text-base leading-none text-zinc-400 transition-colors hover:text-red-500 disabled:pointer-events-none disabled:opacity-0"
              >
                ×
              </button>
            </div>
            <textarea
              aria-label={`Module ${i + 1} seed prompt`}
              rows={2}
              value={mod.seed}
              onChange={(e) =>
                setModules((prev) => prev.map((m, j) => (j === i ? { ...m, seed: e.target.value } : m)))
              }
              placeholder="Seed prompt — the starting instruction text for this Module"
              className={`${inputCls} resize-none`}
            />
          </div>
        ))}
      </div>

      <Field label="Request body template (JSON)" htmlFor="newconn-template">
        <textarea
          id="newconn-template"
          rows={5}
          value={requestTemplate}
          onChange={(e) => setRequestTemplate(e.target.value)}
          className={`${inputCls} resize-none font-mono text-xs`}
        />
      </Field>

      {(missingRefs.length > 0 || undeclaredRefs.length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {missingRefs.map((n) => (
            <p key={`m-${n}`}>
              Module <code className="font-mono">{n}</code> isn&apos;t referenced — add{" "}
              <code className="font-mono">{`{{prompt:${n}}}`}</code> to the template.
            </p>
          ))}
          {undeclaredRefs.map((n) => (
            <p key={`u-${n}`}>
              Template references <code className="font-mono">{`{{prompt:${n}}}`}</code> but no
              Module <code className="font-mono">{n}</code> is declared.
            </p>
          ))}
        </div>
      )}

      <Field label="Response path" htmlFor="newconn-response-path">
        <input
          id="newconn-response-path"
          type="text"
          value={responsePath}
          onChange={(e) => setResponsePath(e.target.value)}
          placeholder="output  or  choices.0.message.content"
          className={`${inputCls} font-mono text-xs`}
        />
      </Field>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-hairline py-2 text-sm last:border-0">
      <span className="w-32 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink">{value}</span>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";
