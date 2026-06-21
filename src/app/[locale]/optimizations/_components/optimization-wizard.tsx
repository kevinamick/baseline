"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { WizardShell, useWizardNav } from "@/app/_components/wizard-shell";
import { toCount, ReviewRow } from "@/app/_components/wizard-primitives";
import { inputCls } from "@/app/_components/form-styles";
import { InstanceSourcePicker, emptyInstanceRow, type InstanceSource } from "@/app/_components/instance-rows-editor";
import { Field } from "@/app/[locale]/rubrics/_components/field";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import { startOptimizationRun } from "@/app/actions/optimizations";
import {
  REFLECT_MODELS,
  DEFAULT_REFLECT_MODEL,
  TARGET_MODELS,
  DEFAULT_TARGET_MODEL,
  type TargetModelId,
} from "@/lib/optimization/models";
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

// Defaults: budget is the one knob a user must think about (it's spend); the rest live under
// Advanced with GEPA-sane defaults (D8/D9).
const DEFAULT_BUDGET = 30;
const DEFAULT_MAX_ITERS = 20;
const DEFAULT_PLATEAU = 5;
const MAX_INSTANCES = 50;

export function OptimizationWizard({ rubrics, connections, maxBudgetRollouts, onClose, onCreated }: Props) {
  const t = useTranslations("Optimizations.wizard");
  // The shared ModulesEditor errors live in their own namespace; thread its translator
  // into modulesEditorError so the wizard's step error matches the editor's hints.
  const tModules = useTranslations("Modules");
  // Localized step names — also the wizard nav's step identifiers (single source).
  const STEP = {
    basics: t("step.basics"),
    system: t("step.system"),
    instances: t("step.instances"),
    tuning: t("step.tuning"),
    review: t("step.review"),
  } as const;
  const STEPS = [STEP.basics, STEP.system, STEP.instances, STEP.tuning, STEP.review];

  // Basics
  const [rubricId, setRubricId] = useState(rubrics[0]?.id ?? "");

  // System — the headline "Paste a prompt" managed mode (#293, default), an existing agent
  // Connection, or an external agent created inline (#108).
  const [connMode, setConnMode] = useState<"managed" | "existing" | "new">("managed");
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  // Managed-mode fields (#293): just the prompt to optimize and the model it runs on. The
  // Connection is auto-named server-side, so there's no name field here.
  const [prompt, setPrompt] = useState("");
  const [targetModel, setTargetModel] = useState<string>(DEFAULT_TARGET_MODEL);
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
      if (raw.length === 0) return { rows: null, error: t("errAddInputRow") };
    } else if (instanceSource === "file") {
      if (importedRows.length === 0) return { rows: null, error: t("errUploadCsv") };
      raw = importedRows;
    } else {
      if (!jsonText.trim()) return { rows: null, error: t("errPasteJson") };
      try {
        raw = parseInstancesJson(jsonText);
      } catch {
        return { rows: null, error: t("errJsonInvalid") };
      }
      if (raw.length === 0) return { rows: null, error: t("errNoInstances") };
    }

    if (raw.length > MAX_INSTANCES) {
      return { rows: null, error: t("errMaxInstances", { max: MAX_INSTANCES, got: raw.length }) };
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

  // Short model name for the managed System's Review summary — the registry label's lead
  // ("Haiku 4.5 — fastest" → "Haiku 4.5"), so it reads "Prompt (managed, Haiku 4.5)".
  const targetModelLabel = (
    TARGET_MODELS.find((m) => m.id === targetModel)?.label ?? targetModel
  ).split(" — ")[0];
  // The single Module a Managed Agent declares; mirrors MANAGED_MODULE_NAME in connections/create.
  const MANAGED_MODULE_LABEL = "prompt";

  function newConnectionError(): string | null {
    if (!connName.trim()) return t("errNameConnection");
    const endpointError = endpointUrlError(endpoint);
    if (endpointError) return endpointError;
    try {
      JSON.parse(requestTemplate);
    } catch {
      return t("errTemplateJson");
    }
    if (!responsePath.trim()) return t("errResponsePath");
    if (authValue.trim() && !authHeader.trim()) {
      return t("errAuthHeader");
    }
    // Modules are mandatory here — an optimization run needs something to tune.
    return modulesEditorError(modules, requestTemplate, { requireModules: true }, tModules);
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

  // The inline-created Connection payload for the two non-existing modes: a Managed Agent (just
  // a prompt + target model; the server auto-names it) or an external agent.
  function buildInlineConnection() {
    if (connMode === "managed") {
      // The dropdown's options are exactly the TARGET_MODELS ids, so the value is always valid;
      // the server re-validates it against the same registry regardless.
      return { type: "managed_agent" as const, targetModel: targetModel as TargetModelId, prompt: prompt.trim() };
    }
    return buildNewConnection();
  }

  function validateStep(s: string): string | null {
    if (s === STEP.basics && !rubricId) return t("errSelectRubric");
    if (s === STEP.system) {
      if (connMode === "managed") {
        if (!prompt.trim()) return t("errPrompt");
      } else if (connMode === "existing") {
        if (!connectionId) return t("errSelectConnection");
      } else {
        return newConnectionError();
      }
    }
    if (s === STEP.instances) {
      const { error } = resolveInstances();
      if (error) return error;
    }
    if (s === STEP.tuning) {
      if (!budgetRollouts || budgetRollouts <= 0) return t("errBudget");
      if (budgetRollouts > maxBudgetRollouts)
        return t("errBudgetMax", { max: maxBudgetRollouts });
      if (!maxIters || maxIters <= 0) return t("errMaxItersMin");
      if (maxIters > 200) return t("errMaxItersMax");
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
          ? t("fileLoaded", { count: rows.length })
          : t("fileNoRows")
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

    // Both "managed" and "new" inline-create a Connection; only "existing" reuses one.
    const usingExisting = connMode === "existing";
    nav.setSubmitError(null);
    nav.setSubmitting(true);
    try {
      const result = await startOptimizationRun({
        // Exactly one of the two — the schema enforces the xor.
        connectionId: usingExisting ? connectionId : undefined,
        newConnection: usingExisting ? undefined : buildInlineConnection(),
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
      nav.setSubmitError(t("errGeneric"));
    } finally {
      nav.setSubmitting(false);
    }
  }

  return (
    <WizardShell
      title={t("title")}
      titleId="opt-wizard-title"
      nav={nav}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={t("submit")}
      submittingLabel={t("submitting")}
    >
      {stepName === STEP.basics && (
        <div className="flex flex-col gap-5">
          <Field label={t("rubricLabel")} htmlFor="opt-rubric">
            <select
              id="opt-rubric"
              value={rubricId}
              onChange={(e) => setRubricId(e.target.value)}
              className={inputCls}
            >
              {rubrics.length === 0 && <option value="">{t("noRubrics")}</option>}
              {rubrics.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-fg-3">
            {t("rubricHint")}
          </p>
          <Field label={t("evalTypeLabel")} htmlFor="opt-type">
            <input
              id="opt-type"
              type="text"
              value={t("evalTypeValue")}
              readOnly
              aria-readonly="true"
              className={`${inputCls} text-fg-4 cursor-default select-none`}
            />
          </Field>
        </div>
      )}

      {stepName === STEP.system && (
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("step.system")}</legend>
            {(
              [
                {
                  id: "managed",
                  title: t("modeManagedTitle"),
                  desc: t("modeManagedDesc"),
                  // The managed mode never depends on existing Connections — it's always reachable.
                  disabled: false,
                },
                {
                  id: "existing",
                  title: t("modeExistingTitle"),
                  // Nothing to pick until the Team has an optimizable Connection.
                  desc: connections.length ? t("modeExistingDesc") : t("modeExistingEmpty"),
                  disabled: connections.length === 0,
                },
                {
                  id: "new",
                  title: t("modeNewTitle"),
                  desc: t("modeNewDesc"),
                  disabled: false,
                },
              ] as const
            ).map((m) => {
              const active = connMode === m.id;
              return (
                <label
                  key={m.id}
                  className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                    active ? "border-accent bg-accent-soft/40" : "border-hairline-cool bg-card"
                  } ${m.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-accent"}`}
                >
                  <input
                    type="radio"
                    name="opt-system-mode"
                    value={m.id}
                    checked={active}
                    disabled={m.disabled}
                    onChange={() => {
                      setConnMode(m.id);
                      nav.setStepError(null);
                    }}
                    className="mt-1 accent-accent"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-ink">{m.title}</span>
                    <span className="text-xs text-fg-3">{m.desc}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {connMode === "managed" && (
            <ManagedAgentFields
              prompt={prompt}
              setPrompt={setPrompt}
              targetModel={targetModel}
              setTargetModel={setTargetModel}
              idPrefix="opt-managed"
            />
          )}

          {connMode === "existing" && (
            <>
              <Field label={t("agentConnectionLabel")} htmlFor="opt-conn">
                <select
                  id="opt-conn"
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className={inputCls}
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t("connectionOption", { name: c.name, count: c.modules.length })}
                    </option>
                  ))}
                </select>
              </Field>
              {selectedConnection && (
                <p className="text-xs text-fg-3">
                  {t("modulesTuned")}{" "}
                  {selectedConnection.modules.map((m) => (
                    <code key={m} className="mr-1 font-mono text-[11px] text-ink">
                      {m}
                    </code>
                  ))}
                </p>
              )}
            </>
          )}

          {connMode === "new" && (
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
        <InstanceSourcePicker
          source={instanceSource}
          setSource={(s) => {
            setInstanceSource(s);
            nav.setStepError(null);
          }}
          intro={t.rich("instancesIntro", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
            userInput: "user_input",
            expectedOutput: "expected_output",
            retrievalContext: "retrieval_context",
          })}
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
          <Field label={t("rolloutBudgetLabel")} htmlFor="opt-budget">
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
            {t.rich("rolloutBudgetHint", {
              b: (chunks) => <span className="font-medium text-ink">{chunks}</span>,
              budget: budgetRollouts,
            })}
          </p>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="self-start text-xs font-medium text-accent-ink hover:underline"
          >
            {showAdvanced ? t("hideAdvanced") : t("showAdvanced")}
          </button>

          {showAdvanced && (
            <div className="flex flex-col gap-5 rounded-lg border border-hairline bg-card-warm p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("maxItersLabel")} htmlFor="opt-maxiters">
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
                <Field label={t("plateauLabel")} htmlFor="opt-plateau">
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
                {t("tuningHint")}
              </p>
              <Field label={t("reflectionModelLabel")} htmlFor="opt-model">
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
          <ReviewRow labelWidth="w-32" label={t("reviewRubric")} value={selectedRubric?.name ?? "—"} />
          <ReviewRow
            labelWidth="w-32"
            label={t("reviewAgent")}
            value={
              connMode === "managed"
                ? t("reviewManaged", { model: targetModelLabel })
                : connMode === "new"
                ? t("reviewNewAgentSuffix", { name: connName.trim() || t("reviewNewAgent") })
                : selectedConnection?.name ?? "—"
            }
          />
          <ReviewRow
            labelWidth="w-32"
            label={t("reviewModules")}
            value={
              connMode === "managed"
                ? MANAGED_MODULE_LABEL
                : connMode === "new"
                ? declaredModuleNames.join(", ") || "—"
                : selectedConnection?.modules.join(", ") || "—"
            }
          />
          <ReviewRow labelWidth="w-32" label={t("reviewInstances")} value={t("reviewInstancesValue", { count: instanceCount() })} />
          <ReviewRow labelWidth="w-32" label={t("reviewRolloutBudget")} value={t("reviewRolloutBudgetValue", { count: budgetRollouts })} />
          <ReviewRow labelWidth="w-32" label={t("reviewMaxIters")} value={String(maxIters)} />
          <ReviewRow
            labelWidth="w-32"
            label={t("reviewPlateau")}
            value={plateauPatience > 0 ? String(plateauPatience) : t("reviewPlateauOff")}
          />
          <ReviewRow
            labelWidth="w-32"
            label={t("reviewReflectionModel")}
            value={REFLECT_MODELS.find((m) => m.id === reflectModel)?.label ?? reflectModel}
          />
        </div>
      )}
    </WizardShell>
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
  const t = useTranslations("Optimizations.wizard");
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-fg-3">
        {t.rich("newConnIntro", {
          code: (chunks) => <code className="font-mono">{chunks}</code>,
          prompt: "{{prompt:<name>}}",
          userInput: "{{user_input}}",
        })}
      </p>

      <Field label={t("connNameLabel")} htmlFor="newconn-name">
        <input
          id="newconn-name"
          type="text"
          value={connName}
          onChange={(e) => setConnName(e.target.value)}
          placeholder={t("connNamePlaceholder")}
          className={inputCls}
        />
      </Field>

      <Field label={t("endpointLabel")} htmlFor="newconn-endpoint">
        <input
          id="newconn-endpoint"
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={t("endpointPlaceholder")}
          className={inputCls}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("authHeaderLabel")} htmlFor="newconn-auth-header" optional>
          <input
            id="newconn-auth-header"
            type="text"
            value={authHeader}
            onChange={(e) => setAuthHeader(e.target.value)}
            placeholder={t("authHeaderPlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("authValueLabel")} htmlFor="newconn-auth-value" optional>
          <input
            id="newconn-auth-value"
            type="password"
            value={authValue}
            onChange={(e) => setAuthValue(e.target.value)}
            placeholder={t("authValuePlaceholder")}
            className={inputCls}
          />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-fg-3">
        {t("credentialsNote")}
      </p>

      {/* Shared Modules editor: rows + request template + live declared↔referenced hints */}
      <ModulesEditor
        modules={modules}
        onModulesChange={setModules}
        requestTemplate={requestTemplate}
        onRequestTemplateChange={setRequestTemplate}
        idPrefix="newconn"
      />

      <Field label={t("responsePathLabel")} htmlFor="newconn-response-path">
        <input
          id="newconn-response-path"
          type="text"
          value={responsePath}
          onChange={(e) => setResponsePath(e.target.value)}
          placeholder={t("responsePathPlaceholder")}
          className={`${inputCls} font-mono text-xs`}
        />
      </Field>
    </div>
  );
}
