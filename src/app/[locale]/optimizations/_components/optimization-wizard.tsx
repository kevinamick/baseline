"use client";

import { useRef, useState } from "react";
import { WizardShell, useWizardNav } from "@/app/_components/wizard-shell";
import { toCount, ReviewRow } from "@/app/_components/wizard-primitives";
import { inputCls } from "@/app/_components/form-styles";
import { InstanceRowsEditor, emptyInstanceRow } from "@/app/_components/instance-rows-editor";
import { Field } from "@/app/[locale]/rubrics/_components/field";
import { startOptimizationRun } from "@/app/actions/optimizations";
import { REFLECT_MODELS, DEFAULT_REFLECT_MODEL } from "@/lib/optimization/models";
import { parseInstancesCsv, parseInstancesJson } from "@/lib/optimization/parse-instances";
import { endpointUrlError } from "@/lib/connections/endpoint";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection } from "@/types/optimization";
import type { InstanceRow } from "@/types/instances";

const DEFAULT_REQUEST_TEMPLATE = `{
  "input": "{{user_input}}",
  "system": "{{prompt:system}}"
}`;

interface Props {
  rubrics: RubricSummary[];
  connections: OptimizableConnection[];
  /** Plan ceiling for budget_rollouts (#181) — the server enforces it too. */
  maxBudgetRollouts: number;
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

export function OptimizationWizard({ rubrics, connections, maxBudgetRollouts, onClose, onCreated }: Props) {
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
  const [manualRows, setManualRows] = useState<InstanceRow[]>([emptyInstanceRow()]);
  const [importedRows, setImportedRows] = useState<InstanceRow[]>([]);
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

  const nav = useWizardNav(STEPS, validateStep);
  const stepName = nav.stepName;
  const selectedRubric = rubrics.find((r) => r.id === rubricId);
  const selectedConnection = connections.find((c) => c.id === connectionId);

  // Resolve the active instance source to cleaned, submit-ready rows (optional fields → null),
  // or an error message for the step. Used by both validation and submit so they never diverge.
  function resolveInstances():
    | { rows: { userInput: string; expectedOutput: string | null; retrievalContext: string | null }[]; error: null }
    | { rows: null; error: string } {
    let raw: InstanceRow[];
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

  // Declared Module names for the Review step (the live declared↔referenced cross-check
  // itself lives in the shared ModulesEditor / modulesEditorError).
  const declaredModuleNames = modules.map((m) => m.name.trim()).filter(Boolean);

  function newConnectionError(): string | null {
    if (!connName.trim()) return "Name the connection.";
    const endpointError = endpointUrlError(endpoint);
    if (endpointError) return endpointError;
    try {
      JSON.parse(requestTemplate);
    } catch {
      return "Request template must be valid JSON.";
    }
    if (!responsePath.trim()) return "Enter the response path.";
    if (authValue.trim() && !authHeader.trim()) {
      return "Add an auth header name for the auth value (e.g. Authorization).";
    }
    // Modules are mandatory here — an optimization run needs something to tune.
    return modulesEditorError(modules, requestTemplate, { requireModules: true });
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
      optimizablePrompts: cleanModules(modules),
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
      if (budgetRollouts > maxBudgetRollouts)
        return `Rollout budget can't exceed ${maxBudgetRollouts} on your plan.`;
      if (!maxIters || maxIters <= 0) return "Max iterations must be 1 or more.";
      if (maxIters > 200) return "Max iterations can't exceed 200.";
    }
    return null;
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
      nav.goToStep(STEP.instances, resolved.error);
      return;
    }

    const usingNew = connMode === "new";
    nav.setSubmitError(null);
    nav.setSubmitting(true);
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
        nav.setSubmitError(result.error);
        return;
      }
      onCreated();
      onClose();
    } catch {
      nav.setSubmitError("Couldn't start the optimization run. Please try again.");
    } finally {
      nav.setSubmitting(false);
    }
  }

  return (
    <WizardShell
      title="New optimization run"
      titleId="opt-wizard-title"
      nav={nav}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="Start run"
      submittingLabel="Starting…"
    >
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
          <p className="text-xs text-fg-3">
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
              className={`${inputCls} text-fg-4 cursor-default select-none`}
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
                    nav.setStepError(null);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    connMode === m ? "bg-card text-ink shadow-sm" : "text-fg-3 hover:text-ink"
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
                <p className="text-xs text-fg-3">
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
            />
          )}
        </div>
      )}

      {stepName === STEP.instances && (
        <InstancesStep
          source={instanceSource}
          setSource={(s) => {
            setInstanceSource(s);
            nav.setStepError(null);
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
              max={maxBudgetRollouts}
              value={budgetRollouts}
              onChange={(e) => setBudgetRollouts(toCount(e.target.value))}
              className={inputCls}
            />
          </Field>
          <p className="text-xs text-fg-3">
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
              <p className="text-xs text-fg-3">
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
          {nav.submitError && (
            <p role="alert" className="text-sm text-danger-fg">
              {nav.submitError}
            </p>
          )}
          <ReviewRow labelWidth="w-32" label="Rubric" value={selectedRubric?.name ?? "—"} />
          <ReviewRow
            labelWidth="w-32"
            label="Agent"
            value={
              connMode === "new"
                ? `${connName.trim() || "New agent"} (new connection)`
                : selectedConnection?.name ?? "—"
            }
          />
          <ReviewRow
            labelWidth="w-32"
            label="Modules"
            value={
              connMode === "new"
                ? declaredModuleNames.join(", ") || "—"
                : selectedConnection?.modules.join(", ") || "—"
            }
          />
          <ReviewRow labelWidth="w-32" label="Instances" value={`${instanceCount()} row(s)`} />
          <ReviewRow labelWidth="w-32" label="Rollout budget" value={`${budgetRollouts} agent call(s)`} />
          <ReviewRow labelWidth="w-32" label="Max iterations" value={String(maxIters)} />
          <ReviewRow
            labelWidth="w-32"
            label="Plateau patience"
            value={plateauPatience > 0 ? String(plateauPatience) : "Off"}
          />
          <ReviewRow
            labelWidth="w-32"
            label="Reflection model"
            value={REFLECT_MODELS.find((m) => m.id === reflectModel)?.label ?? reflectModel}
          />
        </div>
      )}
    </WizardShell>
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
  manualRows: InstanceRow[];
  setManualRows: React.Dispatch<React.SetStateAction<InstanceRow[]>>;
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
              source === s.id ? "bg-card text-ink shadow-sm" : "text-fg-3 hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-fg-3">
        These inputs are frozen at run start; every candidate prompt is scored on the same set.
        Only <code className="font-mono">user_input</code> is required —{" "}
        <code className="font-mono">expected_output</code> and{" "}
        <code className="font-mono">retrieval_context</code> are optional.
      </p>

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
          <p className="text-xs text-fg-4">
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
// {{prompt:*}} Modules to tune via the shared ModulesEditor, which cross-checks them against
// the request template live, so a declared↔referenced mismatch is caught here, not at launch.
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
}) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-fg-3">
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
      <p className="-mt-2 text-xs text-fg-3">
        Credentials are encrypted at rest and in transit, never exposed to the browser, and
        decrypted only server-side when Baseline calls your agent.
      </p>

      {/* Shared Modules editor: rows + request template + live declared↔referenced hints */}
      <ModulesEditor
        modules={modules}
        onModulesChange={setModules}
        requestTemplate={requestTemplate}
        onRequestTemplateChange={setRequestTemplate}
        idPrefix="newconn"
      />

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
