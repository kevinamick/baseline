"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { WizardShell, useWizardNav } from "@/app/_components/wizard-shell";
import { toCount, ReviewRow } from "@/app/_components/wizard-primitives";
import { inputCls } from "@/app/_components/form-styles";
import { InstanceSourcePicker, emptyInstanceRow, type InstanceSource } from "@/app/_components/instance-rows-editor";
import { Field } from "@/app/[locale]/(app)/rubrics/_components/field";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import { startOptimizationRun } from "@/app/actions/optimizations";
import { evalRunPointsPerRow, optimizationRunPointCost } from "@/lib/billing/points";
import {
  DEFAULT_REFLECT_MODEL,
  DEFAULT_SIMPLE_REFLECT_MODEL,
  PROVIDER_DEFAULT_REFLECT_MODEL,
  PROVIDER_DEFAULT_SIMPLE_MODEL,
  TARGET_MODELS,
  DEFAULT_TARGET_MODEL,
  reflectModelGroups,
  reflectModelLabel,
  providerForReflectModel,
  defaultReflectModelFor,
  type TargetModelId,
} from "@/lib/optimization/models";
import { PROVIDER_LABELS, type LlmProvider } from "@/lib/llm/providers";
import type { UsableProvider } from "@/lib/llm/usable-providers";
import type { OptimizationMode } from "@/types/optimization";
import { parseInstancesCsv, parseInstancesJson } from "@/lib/optimization/parse-instances";
import { CONN_TYPE } from "@/lib/connections/wizard-constants";
import {
  ConnectionFields,
  useConnectionDraft,
  connectionDraftError,
  buildConnectionPayload,
} from "@/app/_components/connection-fields";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection, DatasetConnectionOption } from "@/types/optimization";
import type { InstanceRow } from "@/types/instances";
import { MAX_OPTIMIZATION_INSTANCES } from "@/lib/validation/schemas";

const DEFAULT_REQUEST_TEMPLATE = `{
  "input": "{{user_input}}",
  "system": "{{prompt:system}}"
}`;

// The instances step's fourth source (#82): snapshot a dataset Connection's rows once, at run
// start. A small preset list rather than a free-typed minutes field — good enough for "pick a
// window", and each preset stays under the schema's DATASET_SNAPSHOT_MAX_WINDOW_MINUTES ceiling.
const DATASET_WINDOW_PRESETS: { minutes: number; labelKey: string }[] = [
  { minutes: 60, labelKey: "datasetWindowLastHour" },
  { minutes: 1440, labelKey: "datasetWindowLast24h" },
  { minutes: 10080, labelKey: "datasetWindowLast7d" },
  { minutes: 43200, labelKey: "datasetWindowLast30d" },
];

// The inline-connection payload the run action accepts — agent or managed only (no datasets).
// Derived from startOptimizationRun's own input so the two can't drift.
type OptNewConnection = NonNullable<
  Parameters<typeof startOptimizationRun>[0]["newConnection"]
>;

interface Props {
  rubrics: RubricSummary[];
  connections: OptimizableConnection[];
  /** The Team's dataset Connections, eligible for the Instances step's snapshot source (#82).
   *  Optional so existing render tests need not supply it; defaults to none, which hides the
   *  fourth tab entirely (nothing to snapshot from). */
  datasetConnections?: DatasetConnectionOption[];
  /** Providers/models the wizard may offer, with the key each run will use (#204). Optional so
   *  existing render tests need not supply it; defaults to Anthropic on the Team's own key. */
  usableProviders?: UsableProvider[];
  /** Whether the Team is on a paid plan (#204). The Managed Agent ("Paste a prompt") path runs its
   *  target on Baseline's managed Anthropic key — a paid-only feature, and the only path that uses
   *  Simple mode — so Free Teams are never offered it. Defaults true so existing render tests (which
   *  exercise the managed path) need not supply it. */
  isPaid?: boolean;
  /** Plan ceiling for budget_rollouts (#181) — the server enforces it too. */
  maxBudgetRollouts: number;
  /** Included runs left this period (ADR-0016); ≤0 means this run meters Eval
   *  Points. Defaults to 0 so existing render tests need not supply it. */
  remainingRuns?: number;
  onClose: () => void;
  onCreated: () => void;
}

// Defaults: budget is the one knob a user must think about (it's spend); the rest live under
// Advanced with GEPA-sane defaults (D8/D9).
const DEFAULT_BUDGET = 30;
const DEFAULT_MAX_ITERS = 20;
const DEFAULT_PLATEAU = 5;

export function OptimizationWizard({
  rubrics,
  connections,
  datasetConnections = [],
  usableProviders = [{ provider: "anthropic", keySource: "byo" }],
  isPaid = true,
  maxBudgetRollouts,
  remainingRuns = 0,
  onClose,
  onCreated,
}: Props) {
  const t = useTranslations("Optimizations.wizard");
  // Which providers the model dropdowns may offer, and which key each provider's run uses (#204).
  const usableProviderIds = usableProviders.map((p) => p.provider);
  const keySourceByProvider = Object.fromEntries(
    usableProviders.map((p) => [p.provider, p.keySource]),
  ) as Partial<Record<LlmProvider, "byo" | "managed">>;
  const modelGroups = reflectModelGroups(usableProviderIds);
  // The line under a model select naming the key a run will use, e.g. "Runs on your OpenAI key".
  function keyNote(modelId: string): string | null {
    const provider = providerForReflectModel(modelId);
    const source = keySourceByProvider[provider];
    if (!source) return null;
    const args = { provider: PROVIDER_LABELS[provider] };
    return source === "managed" ? t("modelKeyManaged", args) : t("modelKeyByo", args);
  }
  // A model dropdown grouped by provider (only usable providers, #204), plus the key-source note.
  function renderModelSelect(htmlFor: string, label: string, value: string, onChange: (v: string) => void) {
    const note = keyNote(value);
    return (
      <Field label={label} htmlFor={htmlFor}>
        <select id={htmlFor} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
          {modelGroups.length === 0 && <option value="">{t("noUsableProviders")}</option>}
          {modelGroups.map((g) => (
            <optgroup key={g.provider} label={g.label}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {note && <p className="mt-1.5 text-xs text-fg-3">{note}</p>}
      </Field>
    );
  }
  // The shared ModulesEditor errors live in their own namespace; thread its translator
  // into modulesEditorError so the wizard's step error matches the editor's hints.
  const tModules = useTranslations("Modules");
  // The shared connection-create form's copy lives in its own namespace; used for the inline
  // agent's validation.
  const tFields = useTranslations("Connections.fields");
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

  // System — the headline "Paste a prompt" managed mode (#293, default for paid Teams), an existing
  // agent Connection, or an external agent created inline (#108). The managed path is paid-only
  // (#204), so a Free Team starts on an external-agent mode instead.
  const [connMode, setConnMode] = useState<"managed" | "existing" | "new">(
    isPaid ? "managed" : connections.length ? "existing" : "new",
  );
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  // Managed-mode fields (#293): just the prompt to optimize and the model it runs on. The
  // Connection is auto-named server-side, so there's no name field here.
  const [prompt, setPrompt] = useState("");
  const [targetModel, setTargetModel] = useState<string>(DEFAULT_TARGET_MODEL);
  // Inline new-connection form state (agent-only — datasets can't be optimized), shared with the
  // schedule wizard and Add Connection dialog via useConnectionDraft. Seeded with the
  // {{prompt:system}} request body and a mandatory `system` Module to tune.
  const conn = useConnectionDraft({
    connType: CONN_TYPE.agent,
    requestTemplate: DEFAULT_REQUEST_TEMPLATE,
    modules: [{ name: "system", seed: "" }],
  });
  const { draft } = conn;

  // Instances — three inline sources (manual/CSV/JSON) plus, when the Team has at least one
  // dataset Connection, a fourth "dataset snapshot" source (#82).
  const [instanceSource, setInstanceSource] = useState<InstanceSource | "dataset">("manual");
  const [manualRows, setManualRows] = useState<InstanceRow[]>([emptyInstanceRow()]);
  const [importedRows, setImportedRows] = useState<InstanceRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  // Monotonic upload id so a slow earlier CSV decode can't overwrite a newer one out of order.
  const uploadSeq = useRef(0);
  // Dataset-snapshot source state: which Connection, and how far back to look. The window is a
  // small preset list (see DATASET_WINDOW_PRESETS) rather than a free-typed value.
  const [datasetConnectionId, setDatasetConnectionId] = useState(datasetConnections[0]?.id ?? "");
  // The effective selection self-heals instead of trusting mount-time state: if the stored id
  // doesn't match a current Connection (the list arrived after mount via router.refresh, or the
  // picked Connection was deleted), fall back to the first option — which is exactly what the
  // controlled <select> DISPLAYS in that state, so validation can never disagree with what the
  // user sees selected.
  const effectiveDatasetConnectionId = datasetConnections.some((c) => c.id === datasetConnectionId)
    ? datasetConnectionId
    : (datasetConnections[0]?.id ?? "");
  const [datasetWindowMinutes, setDatasetWindowMinutes] = useState(DATASET_WINDOW_PRESETS[1].minutes);

  // Optimization mode: Simple (default for managed agents) or Reflective.
  // Only meaningful when connMode === "managed"; external/multi-module agents always run Reflective.
  const [optimMode, setOptimMode] = useState<OptimizationMode>("simple");

  // Tuning
  const [budgetRollouts, setBudgetRollouts] = useState(DEFAULT_BUDGET);
  const [maxIters, setMaxIters] = useState(DEFAULT_MAX_ITERS);
  const [plateauPatience, setPlateauPatience] = useState(DEFAULT_PLATEAU);
  // Reflective mode uses Sonnet by default; Simple mode uses Haiku (cheaper, runs far more often).
  // When the Team can't use Anthropic, fall back to the first usable provider's default (#204).
  const [reflectModel, setReflectModel] = useState<string>(
    defaultReflectModelFor(usableProviderIds, DEFAULT_REFLECT_MODEL, PROVIDER_DEFAULT_REFLECT_MODEL) ??
      DEFAULT_REFLECT_MODEL,
  );
  const [simpleGenModel, setSimpleGenModel] = useState<string>(
    defaultReflectModelFor(usableProviderIds, DEFAULT_SIMPLE_REFLECT_MODEL, PROVIDER_DEFAULT_SIMPLE_MODEL) ??
      DEFAULT_SIMPLE_REFLECT_MODEL,
  );
  const [showSimpleAdvanced, setShowSimpleAdvanced] = useState(false);
  const [showReflectiveAdvanced, setShowReflectiveAdvanced] = useState(false);

  const nav = useWizardNav(STEPS, validateStep);
  const stepName = nav.stepName;
  const selectedRubric = rubrics.find((r) => r.id === rubricId);
  const selectedConnection = connections.find((c) => c.id === connectionId);

  // Pre-run Eval Point projection (ADR-0016). A run within the included run-count
  // costs no points; past it (a paid Team's overage) it meters worst-case points,
  // budget_rollouts × per-rollout cost. Shown only when the rubric's criterion
  // count is known (older pickers may omit it), mirroring the eval run dialog.
  const criteriaCount = selectedRubric?.criteriaCount;
  const drawsPoints = remainingRuns < 1;
  const projectedPoints =
    criteriaCount != null
      ? optimizationRunPointCost(budgetRollouts, criteriaCount)
      : null;

  // Simple mode is only available for paste-a-prompt Managed Agents.
  // External and multi-module agents always run Reflective regardless of the selector.
  const isSimpleMode = connMode === "managed" && optimMode === "simple";
  const showAdvanced = isSimpleMode ? showSimpleAdvanced : showReflectiveAdvanced;

  // Where the instances step's active source resolves to: inline rows (already cleaned,
  // optional fields → null) or a dataset snapshot spec — the two members of the action's
  // instancesSource union (#82). A further source (e.g. seeding from an existing Eval Run, #83)
  // is just another member here, mirroring the schema.
  type ResolvedInstancesSource =
    | {
        type: "inline";
        rows: { userInput: string; expectedOutput: string | null; retrievalContext: string | null }[];
      }
    | { type: "dataset_snapshot"; connectionId: string; windowMinutes: number };

  // Resolve the active instance source, or an error message for the step. Used by both
  // validation and submit so they never diverge.
  function resolveInstancesSource():
    | { source: ResolvedInstancesSource; error: null }
    | { source: null; error: string } {
    if (instanceSource === "dataset") {
      if (!effectiveDatasetConnectionId) return { source: null, error: t("errSelectDatasetConnection") };
      return {
        source: {
          type: "dataset_snapshot",
          connectionId: effectiveDatasetConnectionId,
          windowMinutes: datasetWindowMinutes,
        },
        error: null,
      };
    }

    let raw: InstanceRow[];
    if (instanceSource === "manual") {
      raw = manualRows.filter((r) => r.userInput.trim());
      if (raw.length === 0) return { source: null, error: t("errAddInputRow") };
    } else if (instanceSource === "file") {
      if (importedRows.length === 0) return { source: null, error: t("errUploadCsv") };
      raw = importedRows;
    } else {
      if (!jsonText.trim()) return { source: null, error: t("errPasteJson") };
      try {
        raw = parseInstancesJson(jsonText);
      } catch {
        return { source: null, error: t("errJsonInvalid") };
      }
      if (raw.length === 0) return { source: null, error: t("errNoInstances") };
    }

    if (raw.length > MAX_OPTIMIZATION_INSTANCES) {
      return { source: null, error: t("errMaxInstances", { max: MAX_OPTIMIZATION_INSTANCES, got: raw.length }) };
    }

    return {
      source: {
        type: "inline",
        rows: raw.map((r) => ({
          userInput: r.userInput.trim(),
          expectedOutput: r.expectedOutput.trim() || null,
          retrievalContext: r.retrievalContext.trim() || null,
        })),
      },
      error: null,
    };
  }

  // Inline row count shown on Review = exactly what will be submitted (a single source of
  // truth: the same resolveInstancesSource() the submit uses). Null for the dataset-snapshot
  // source (the row count isn't known until the server fetches it) or an unresolved source.
  function inlineInstanceCount(): number | null {
    const { source } = resolveInstancesSource();
    return source?.type === "inline" ? source.rows.length : null;
  }

  const selectedDatasetConnection = datasetConnections.find(
    (c) => c.id === effectiveDatasetConnectionId
  );
  const selectedWindowLabelKey =
    DATASET_WINDOW_PRESETS.find((p) => p.minutes === datasetWindowMinutes)?.labelKey ??
    DATASET_WINDOW_PRESETS[0].labelKey;

  // Declared Module names for the Review step (the live declared↔referenced cross-check
  // itself lives in the shared ModulesEditor / modulesEditorError).
  const declaredModuleNames = draft.modules
    .map((m) => m.name.trim())
    .filter(Boolean);

  // Short model name for the managed System's Review summary — the registry label's lead
  // ("Haiku 4.5 — fastest" → "Haiku 4.5"), so it reads "Prompt (managed, Haiku 4.5)".
  const targetModelLabel = (
    TARGET_MODELS.find((m) => m.id === targetModel)?.label ?? targetModel
  ).split(" — ")[0];
  const simpleGenModelLabel = reflectModelLabel(simpleGenModel).split(" — ")[0];
  // The single Module a Managed Agent declares; mirrors MANAGED_MODULE_NAME in connections/create.
  const MANAGED_MODULE_LABEL = "prompt";

  // The inline-created Connection payload for the two non-existing modes: a Managed Agent (just
  // a prompt + target model; the server auto-names it) or an external agent (the shared draft).
  // An optimization run only ever creates an agent or managed Connection — datasets can't be
  // optimized — so the draft (always connType "agent" here, Modules required) narrows to the
  // action's agent variant; the server re-validates with NewOptimizationConnectionSchema.
  function buildInlineConnection(): OptNewConnection {
    if (connMode === "managed") {
      // The dropdown's options are exactly the TARGET_MODELS ids, so the value is always valid;
      // the server re-validates it against the same registry regardless.
      return { type: CONN_TYPE.managedAgent, targetModel: targetModel as TargetModelId, prompt: prompt.trim() };
    }
    return buildConnectionPayload(draft) as OptNewConnection;
  }

  function validateStep(s: string): string | null {
    if (s === STEP.basics && !rubricId) return t("errSelectRubric");
    if (s === STEP.system) {
      if (connMode === "managed") {
        if (!prompt.trim()) return t("errPrompt");
      } else if (connMode === "existing") {
        if (!connectionId) return t("errSelectConnection");
      } else {
        // Modules are mandatory here — an optimization run needs something to tune (#119).
        return connectionDraftError(draft, {
          managedAllowed: isPaid,
          requireModules: true,
          t: tFields,
          tModules,
        });
      }
    }
    if (s === STEP.instances) {
      const { error } = resolveInstancesSource();
      if (error) return error;
    }
    if (s === STEP.tuning) {
      if (!budgetRollouts || budgetRollouts <= 0) return t("errBudget");
      if (budgetRollouts > maxBudgetRollouts)
        return t("errBudgetMax", { max: maxBudgetRollouts });
      if (!maxIters || maxIters <= 0) return t(isSimpleMode ? "errMaxRoundsMin" : "errMaxItersMin");
      if (maxIters > 200) return t(isSimpleMode ? "errMaxRoundsMax" : "errMaxItersMax");
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
    }).catch(() => {
      if (seq !== uploadSeq.current) return;
      setFileNote(t("fileReadError"));
    });
  }

  async function handleSubmit() {
    const resolved = resolveInstancesSource();
    if (resolved.source === null) {
      // Send the user back to the Instances step rather than failing opaquely on Review.
      nav.goToStep(STEP.instances, resolved.error);
      return;
    }
    // Reshape into the action's instancesSource union (#82): inline rows, already resolved
    // above, or the dataset-Connection snapshot spec the server resolves at run start.
    const instancesSource =
      resolved.source.type === "inline"
        ? { type: "inline" as const, instances: resolved.source.rows }
        : {
            type: "dataset_snapshot" as const,
            connectionId: resolved.source.connectionId,
            windowMinutes: resolved.source.windowMinutes,
          };

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
        instancesSource,
        budgetRollouts,
        maxIters,
        // 0 (the toCount of a cleared field) means "no plateau early-stop".
        plateauPatience: plateauPatience > 0 ? plateauPatience : null,
        mode: isSimpleMode ? "simple" : "reflective",
        reflectModel: isSimpleMode ? simpleGenModel : reflectModel,
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
            <legend className="sr-only">{t("systemModeLegend")}</legend>
            {(
              [
                {
                  id: "managed" as const,
                  title: t("modeManagedTitle"),
                  desc: t("modeManagedDesc"),
                  // The managed mode never depends on existing Connections — it's always reachable.
                  disabled: false,
                  // Paid-only (#204): the managed System runs its target on Baseline's managed key,
                  // and it's the only path that uses Simple mode. Free Teams never see it.
                  paidOnly: true,
                },
                {
                  id: "existing" as const,
                  title: t("modeExistingTitle"),
                  // Nothing to pick until the Team has an optimizable Connection.
                  desc: connections.length ? t("modeExistingDesc") : t("modeExistingEmpty"),
                  disabled: connections.length === 0,
                  paidOnly: false,
                },
                {
                  id: "new" as const,
                  title: t("modeNewTitle"),
                  desc: t("modeNewDesc"),
                  disabled: false,
                  paidOnly: false,
                },
              ]
                .filter((m) => isPaid || !m.paidOnly)
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
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-ink">{t("optModeLegend")}</legend>
                {(
                  [
                    {
                      id: "simple" as const,
                      title: t("optModeSimpleTitle"),
                      desc: t("optModeSimpleDesc"),
                    },
                    {
                      id: "reflective" as const,
                      title: t("optModeReflectiveTitle"),
                      desc: t("optModeReflectiveDesc"),
                    },
                  ]
                ).map((m) => {
                  const active = optimMode === m.id;
                  return (
                    <label
                      key={m.id}
                      className={`flex items-start gap-3 rounded-lg border p-3 transition-colors cursor-pointer ${
                        active ? "border-accent bg-accent-soft/40" : "border-hairline-cool bg-card hover:border-accent"
                      }`}
                    >
                      <input
                        type="radio"
                        name="opt-mode"
                        value={m.id}
                        checked={active}
                        onChange={() => setOptimMode(m.id)}
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
              <ManagedAgentFields
                prompt={prompt}
                setPrompt={setPrompt}
                targetModel={targetModel}
                setTargetModel={setTargetModel}
                idPrefix="opt-managed"
              />
            </>
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
            // Inline external-agent form — the shared <ConnectionFields> with the type picker
            // hidden (datasets can't be optimized) and Modules mandatory (#119, #353).
            <ConnectionFields
              hook={conn}
              managedAllowed={isPaid}
              idPrefix="newconn"
              showTypePicker={false}
              requireModules
              onClearError={() => nav.setStepError(null)}
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
          extraTabs={
            datasetConnections.length > 0
              ? [
                  {
                    id: "dataset" as const,
                    label: t("instancesDataset"),
                    content: (
                      <div className="flex flex-col gap-4">
                        <Field label={t("datasetConnectionLabel")} htmlFor="opt-dataset-conn">
                          <select
                            id="opt-dataset-conn"
                            value={effectiveDatasetConnectionId}
                            onChange={(e) => setDatasetConnectionId(e.target.value)}
                            className={inputCls}
                          >
                            {datasetConnections.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t("datasetWindowLabel")} htmlFor="opt-dataset-window">
                          <select
                            id="opt-dataset-window"
                            value={datasetWindowMinutes}
                            onChange={(e) => setDatasetWindowMinutes(Number(e.target.value))}
                            className={inputCls}
                          >
                            {DATASET_WINDOW_PRESETS.map((p) => (
                              <option key={p.minutes} value={p.minutes}>
                                {t(p.labelKey)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <p className="text-xs text-fg-3">
                          {t("datasetSnapshotIntro", { max: MAX_OPTIMIZATION_INSTANCES })}
                        </p>
                      </div>
                    ),
                  },
                ]
              : []
          }
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

          {isSimpleMode &&
            renderModelSelect("opt-gen-model", t("genModelLabel"), simpleGenModel, setSimpleGenModel)}

          <button
            type="button"
            onClick={() => {
              if (isSimpleMode) setShowSimpleAdvanced((v) => !v);
              else setShowReflectiveAdvanced((v) => !v);
            }}
            className="self-start text-xs font-medium text-accent-ink hover:underline"
          >
            {showAdvanced ? t("hideAdvanced") : t("showAdvanced")}
          </button>

          {showAdvanced && (
            <div className="flex flex-col gap-5 rounded-lg border border-hairline bg-card-warm p-4">
              {isSimpleMode ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("maxRoundsLabel")} htmlFor="opt-maxiters">
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
                  <Field label={t("plateauRoundsLabel")} htmlFor="opt-plateau">
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
              ) : (
                <>
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
                  {renderModelSelect("opt-model", t("reflectionModelLabel"), reflectModel, setReflectModel)}
                </>
              )}
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
                ? t("reviewNewAgentSuffix", { name: draft.connName.trim() || t("reviewNewAgent") })
                : selectedConnection?.name ?? "—"
            }
          />
          {connMode === "managed" && (
            <ReviewRow
              labelWidth="w-32"
              label={t("reviewMode")}
              value={isSimpleMode ? t("reviewModeSimple") : t("reviewModeReflective")}
            />
          )}
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
          <ReviewRow
            labelWidth="w-32"
            label={t("reviewInstances")}
            value={
              inlineInstanceCount() != null
                ? t("reviewInstancesValue", { count: inlineInstanceCount() ?? 0 })
                : t("reviewInstancesValueDataset", { max: MAX_OPTIMIZATION_INSTANCES })
            }
          />
          <ReviewRow
            labelWidth="w-32"
            label={t("reviewInstancesSource")}
            value={
              instanceSource === "manual"
                ? t("reviewSourceManual")
                : instanceSource === "file"
                ? t("reviewSourceFile")
                : instanceSource === "json"
                ? t("reviewSourceJson")
                : t("reviewSourceDataset", {
                    name: selectedDatasetConnection?.name ?? "—",
                    window: t(selectedWindowLabelKey),
                  })
            }
          />
          <ReviewRow labelWidth="w-32" label={t("reviewRolloutBudget")} value={t("reviewRolloutBudgetValue", { count: budgetRollouts })} />
          {projectedPoints != null && (
            <ReviewRow
              labelWidth="w-32"
              label={t("reviewPointCost")}
              value={
                drawsPoints
                  ? t("reviewPointCostOverage", {
                      points: projectedPoints.toLocaleString(),
                      rollouts: budgetRollouts,
                      perRollout: evalRunPointsPerRow(criteriaCount ?? 0),
                    })
                  : t("reviewPointCostIncluded", { remaining: remainingRuns })
              }
            />
          )}
          {isSimpleMode ? (
            <ReviewRow
              labelWidth="w-32"
              label={t("genModelLabel")}
              value={simpleGenModelLabel}
            />
          ) : (
            <>
              <ReviewRow labelWidth="w-32" label={t("reviewMaxIters")} value={String(maxIters)} />
              <ReviewRow
                labelWidth="w-32"
                label={t("reviewPlateau")}
                value={plateauPatience > 0 ? String(plateauPatience) : t("reviewPlateauOff")}
              />
              <ReviewRow
                labelWidth="w-32"
                label={t("reviewReflectionModel")}
                value={reflectModelLabel(reflectModel)}
              />
            </>
          )}
        </div>
      )}
    </WizardShell>
  );
}
