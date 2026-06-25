"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { WizardShell, useWizardNav } from "@/app/_components/wizard-shell";
import { toCount, ReviewRow } from "@/app/_components/wizard-primitives";
import { inputCls } from "@/app/_components/form-styles";
import { InstanceSourcePicker, emptyInstanceRow, type InstanceSource } from "@/app/_components/instance-rows-editor";
import { EmailTagsField, useEmailTags } from "@/app/_components/email-tags-field";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import { parseInstancesCsv, parseInstancesJson } from "@/lib/optimization/parse-instances";
import {
  TARGET_MODELS,
  DEFAULT_TARGET_MODEL,
  type TargetModelId,
} from "@/lib/optimization/models";
import { Switch } from "@/app/_components/switch";
import { Field } from "@/app/[locale]/(app)/rubrics/_components/field";
import { createSchedule } from "@/app/actions/schedules";
import { type ScheduleFrequency } from "@/types/schedule";
import { endpointUrlError } from "@/lib/connections/endpoint";
import { isAllowedPosthogHostUrl, POSTHOG_HOST_MESSAGE } from "@/lib/connections/posthog-host";
import { isDatasetConnectionType } from "@/lib/validation/schemas";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import type { RubricSummary } from "@/types/rubric";
import type { ConnectionSummary } from "@/types/schedule";
import type { InstanceRow } from "@/types/instances";

// Connection-type values — also the discriminator the server's NewConnectionSchema expects.
const CONN_TYPE = {
  agent: "agent",
  managedAgent: "managed_agent",
  customDataset: "custom_dataset",
  posthogDataset: "posthog_dataset",
} as const;

type ConnType = (typeof CONN_TYPE)[keyof typeof CONN_TYPE];

// A managed Connection (the "Paste a prompt" System) runs on Baseline's managed LLM — a paid-plan
// feature gated in the picker (#294).
function isManagedConnection(c: ConnectionSummary): boolean {
  return c.agent_kind === "managed";
}

interface Props {
  rubrics: RubricSummary[];
  connections: ConnectionSummary[];
  /** Paid plans can select/create a Managed Agent System; Free sees it disabled with an upgrade CTA. */
  managedAllowed: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const DEFAULT_TEMPLATE = `{
  "input": "{{user_input}}"
}`;

// Custom dataset: query-string params, rendered with the window/limit placeholders.
const DEFAULT_QUERY_TEMPLATE = `{
  "from": "{{window_start}}",
  "to": "{{window_end}}",
  "limit": "{{max_rows}}"
}`;

// PostHog: a HogQL query whose column aliases match our field names. The window/limit
// placeholders are rendered server-side at each fire.
const DEFAULT_HOGQL = `SELECT
  properties.$ai_input AS user_input,
  properties.$ai_output_choices AS agent_output
FROM events
WHERE event = '$ai_generation'
  AND timestamp >= '{{window_start}}'
  AND timestamp <  '{{window_end}}'
LIMIT {{max_rows}}`;

// A sensible default lookback per cadence (minutes): one period of history per fire.
function defaultWindowForFrequency(freq: ScheduleFrequency): number {
  switch (freq) {
    case "hourly":
      return 60;
    case "daily":
      return 1440;
    case "weekly":
      return 10080;
    case "monthly":
      return 43200;
  }
}

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezoneOptions(current: string): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.("timeZone");
    if (supported && supported.length) {
      return supported.includes(current) ? supported : [current, ...supported];
    }
  } catch {
    /* fall through */
  }
  return Array.from(new Set([current, "UTC", "America/New_York", "Europe/London"]));
}

export function ScheduleWizard({ rubrics, connections, managedAllowed, onClose, onCreated }: Props) {
  const t = useTranslations("Schedules.wizard");
  const locale = useLocale();
  // Localized short weekday names (Mon=1 … Sun=7), so the weekly picker and the
  // cadence summary read in the active locale instead of the hardcoded English
  // DAY_LABELS. 2024-01-01 is a Monday, so value v maps to Jan v.
  const dayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return [1, 2, 3, 4, 5, 6, 7].map((value) => ({
      value,
      label: fmt.format(new Date(Date.UTC(2024, 0, value))),
    }));
  }, [locale]);
  // The shared ModulesEditor errors live in their own namespace; thread its translator
  // into modulesEditorError so the wizard's step error matches the editor's hints.
  const tModules = useTranslations("Modules");

  // Connection-type display labels — keyed off the const set (single source). Insertion order is
  // the pill order: the managed "Paste a prompt" System leads (the default, no-setup choice),
  // then the live agent, then the dataset types.
  const CONN_TYPE_LABELS: Record<ConnType, string> = {
    [CONN_TYPE.managedAgent]: t("connType.managedAgent"),
    [CONN_TYPE.agent]: t("connType.agent"),
    [CONN_TYPE.posthogDataset]: t("connType.posthogDataset"),
    [CONN_TYPE.customDataset]: t("connType.customDataset"),
  };

  // Localized step names — also the wizard nav's step identifiers (single source).
  // Inputs is agent-only; dataset shows sampling on Cadence instead, so the two flows
  // differ by one step — hence two step lists rather than one.
  const STEP = {
    basics: t("step.basics"),
    system: t("step.system"),
    inputs: t("step.inputs"),
    cadence: t("step.cadence"),
    notify: t("step.notify"),
    review: t("step.review"),
  } as const;
  const AGENT_STEPS = [STEP.basics, STEP.system, STEP.inputs, STEP.cadence, STEP.notify, STEP.review];
  const DATASET_STEPS = [STEP.basics, STEP.system, STEP.cadence, STEP.notify, STEP.review];

  // Step — Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubricId, setRubricId] = useState(rubrics[0]?.id ?? "");

  // Step — System (Connection)
  // The existing-connection picker still LISTS managed Connections, but a Free Team can't select
  // them (they render disabled). Default the selection — and whether the "existing" mode opens at
  // all — to a Connection the Team can actually use.
  const selectableConnections = managedAllowed
    ? connections
    : connections.filter((c) => !isManagedConnection(c));
  // Paid Teams land on the managed "Paste a prompt" create flow by default — it's the
  // no-setup choice and mirrors the optimization wizard's default System (#294). Free Teams
  // can't use it (the pill is disabled), so they fall back to an existing Connection when one
  // is selectable, otherwise the create flow with the live-agent type.
  const [connMode, setConnMode] = useState<"existing" | "new">(
    managedAllowed ? "new" : selectableConnections.length ? "existing" : "new"
  );
  const [connectionId, setConnectionId] = useState(selectableConnections[0]?.id ?? "");
  const [connType, setConnType] = useState<ConnType>(
    managedAllowed ? CONN_TYPE.managedAgent : CONN_TYPE.agent
  );
  const [connName, setConnName] = useState("");
  // Managed "Paste a prompt" fields (#294): just the prompt and the model it runs on. The managed
  // Connection is auto-named server-side, so there's no name field.
  const [managedPrompt, setManagedPrompt] = useState("");
  const [managedTargetModel, setManagedTargetModel] = useState<string>(DEFAULT_TARGET_MODEL);
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [requestTemplate, setRequestTemplate] = useState(DEFAULT_TEMPLATE);
  const [responsePath, setResponsePath] = useState("output");
  // Agent-only: optional optimizable Modules ({ name, seed }) declared at creation, so a
  // connection born here is selectable in the optimization wizard too (#119).
  const [modules, setModules] = useState<ModuleRow[]>([]);
  // Custom dataset field map.
  const [mapUserInput, setMapUserInput] = useState("input");
  const [mapAgentOutput, setMapAgentOutput] = useState("output");
  // PostHog.
  const [phHost, setPhHost] = useState("https://us.posthog.com");
  const [phProjectId, setPhProjectId] = useState("");
  const [phApiKey, setPhApiKey] = useState("");
  const [phHogql, setPhHogql] = useState(DEFAULT_HOGQL);

  // Step — Inputs (agent only, tri-source)
  const [inputs, setInputs] = useState<InstanceRow[]>([emptyInstanceRow()]);
  const [instanceSource, setInstanceSource] = useState<InstanceSource>("manual");
  const [importedRows, setImportedRows] = useState<InstanceRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importFileNote, setImportFileNote] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  const uploadSeq = useRef(0);

  // Step — Cadence
  const [frequency, setFrequency] = useState<ScheduleFrequency>("daily");
  const [localHour, setLocalHour] = useState(9);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1, 2, 3, 4, 5]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState(detectTimezone());
  // Dataset sampling (Cadence step, dataset only).
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const [maxRows, setMaxRows] = useState(100);

  // Step — Notify & enable
  const emailTags = useEmailTags();
  const [enabled, setEnabled] = useState(true);

  const tzOptions = timezoneOptions(timezone);

  const selectedConnection = connections.find((c) => c.id === connectionId);
  const isDataset =
    connMode === "new" ? isDatasetConnectionType(connType) : selectedConnection?.kind === "dataset";

  // Inputs is agent-only; dataset shows sampling on Cadence instead. Render by step NAME
  // so the shifting index never points at the wrong panel.
  const steps = isDataset ? DATASET_STEPS : AGENT_STEPS;
  const nav = useWizardNav(steps, validateStep);
  const stepName = nav.stepName;

  function resolveInputs():
    | { rows: { userInput: string; expectedOutput: string | null; retrievalContext: string | null }[]; error: null }
    | { rows: null; error: string } {
    let raw: InstanceRow[];
    if (instanceSource === "manual") {
      raw = inputs.filter((r) => r.userInput.trim());
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
    return {
      rows: raw.map((r) => ({
        userInput: r.userInput.trim(),
        expectedOutput: r.expectedOutput.trim() || null,
        retrievalContext: r.retrievalContext.trim() || null,
      })),
      error: null,
    };
  }

  function onInputFile(file: File) {
    const seq = ++uploadSeq.current;
    setImportFileName(file.name);
    void file.text().then((text) => {
      if (seq !== uploadSeq.current) return;
      const rows = parseInstancesCsv(text);
      setImportedRows(rows);
      setImportFileNote(
        rows.length > 0
          ? t("fileLoaded", { count: rows.length })
          : t("fileNoRows")
      );
    }).catch(() => {
      if (seq !== uploadSeq.current) return;
      setImportFileNote(t("fileReadError"));
    });
  }

  function changeFrequency(f: ScheduleFrequency) {
    setFrequency(f);
    setWindowMinutes(defaultWindowForFrequency(f));
  }

  function toggleDay(value: number) {
    setDaysOfWeek((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value].sort()
    );
  }

  // Per-step client validation, keyed by step name. Returns an error string or null.
  function validateStep(s: string): string | null {
    if (s === STEP.basics) {
      if (!name.trim()) return t("errName");
      if (!rubricId) return t("errSelectRubric");
    }
    if (s === STEP.system) {
      if (connMode === "existing") {
        if (!connectionId) return t("errSelectConnection");
        // Belt to the disabled options: a Free Team can't schedule against a managed Connection.
        const sel = connections.find((c) => c.id === connectionId);
        if (sel && isManagedConnection(sel) && !managedAllowed) return t("errManagedPaid");
      } else if (connType === CONN_TYPE.managedAgent) {
        // Belt to the disabled pill — the server gate (#292) is the authority.
        if (!managedAllowed) return t("errManagedPaid");
        if (!managedPrompt.trim()) return t("errPrompt");
      } else if (connType === CONN_TYPE.posthogDataset) {
        if (!connName.trim()) return t("errNameConnection");
        const phHostError = endpointUrlError(phHost);
        if (phHostError) return phHostError;
        if (!isAllowedPosthogHostUrl(phHost)) return POSTHOG_HOST_MESSAGE;
        if (!phProjectId.trim()) return t("errProjectId");
        if (!phApiKey.trim()) return t("errApiKey");
        if (!phHogql.trim()) return t("errHogql");
      } else {
        // agent or custom_dataset
        if (!connName.trim()) return t("errNameConnection");
        const endpointError = endpointUrlError(endpoint);
        if (endpointError) return endpointError;
        try {
          JSON.parse(requestTemplate);
        } catch {
          return connType === CONN_TYPE.agent
            ? t("errRequestTemplateJson")
            : t("errQueryTemplateJson");
        }
        if (!responsePath.trim())
          return connType === CONN_TYPE.agent ? t("errResponsePath") : t("errRowsPath");
        if (connType === CONN_TYPE.customDataset && (!mapUserInput.trim() || !mapAgentOutput.trim()))
          return t("errMapPaths");
        // Belt-and-braces: a {{prompt:*}} ref in a dataset query template would be sent
        // literally to the customer's API — Modules only exist on agent connections.
        if (connType === CONN_TYPE.customDataset && extractPromptRefs(requestTemplate).length > 0)
          return t("errPromptRefDataset");
        if (authValue.trim() && !authHeader.trim())
          return t("errAuthHeader");
        if (connType === CONN_TYPE.agent) {
          // Modules are optional for a scheduled agent, but when declared the shared
          // declared↔referenced cross-validation applies (#119).
          const mErr = modulesEditorError(modules, requestTemplate, { requireModules: false }, tModules);
          if (mErr) return mErr;
        }
      }
    }
    if (s === STEP.inputs) {
      const { error } = resolveInputs();
      if (error) return error;
    }
    if (s === STEP.cadence) {
      if (frequency !== "hourly" && localHour == null) return t("errPickHour");
      if (frequency === "weekly" && daysOfWeek.length === 0) return t("errPickDay");
      if (frequency === "monthly" && !dayOfMonth) return t("errPickDayOfMonth");
      if (isDataset) {
        if (!windowMinutes || windowMinutes <= 0) return t("errLookback");
        if (!maxRows || maxRows <= 0) return t("errMaxRows");
      }
    }
    return null;
  }

  function buildNewConnection() {
    if (connType === CONN_TYPE.managedAgent) {
      // The dropdown's options are exactly the TARGET_MODELS ids, so the value is always valid; the
      // server re-validates it against the same registry. No name field — the server auto-names it.
      return {
        type: CONN_TYPE.managedAgent,
        targetModel: managedTargetModel as TargetModelId,
        prompt: managedPrompt.trim(),
      };
    }
    if (connType === CONN_TYPE.posthogDataset) {
      return {
        type: CONN_TYPE.posthogDataset,
        name: connName.trim(),
        host: phHost.trim(),
        projectId: phProjectId.trim(),
        apiKey: phApiKey.trim(),
        hogql: phHogql,
      };
    }
    if (connType === CONN_TYPE.customDataset) {
      return {
        type: CONN_TYPE.customDataset,
        name: connName.trim(),
        endpoint: endpoint.trim(),
        authHeader: authHeader.trim() || null,
        authValue: authValue || null,
        requestTemplate,
        responsePath: responsePath.trim(),
        fieldMap: {
          userInput: mapUserInput.trim(),
          agentOutput: mapAgentOutput.trim(),
        },
      };
    }
    return {
      type: CONN_TYPE.agent,
      name: connName.trim(),
      endpoint: endpoint.trim(),
      authHeader: authHeader.trim() || null,
      authValue: authValue || null,
      requestTemplate,
      responsePath: responsePath.trim(),
      // Declared Modules persist on the Connection, making it optimizable later.
      optimizablePrompts: cleanModules(modules),
    };
  }

  async function handleSubmit() {
    nav.setSubmitError(null);
    nav.setSubmitting(true);

    const resolvedInputs = isDataset ? { rows: [] as { userInput: string; expectedOutput: string | null; retrievalContext: string | null }[], error: null } : resolveInputs();
    if (resolvedInputs.rows === null) {
      nav.setSubmitError(resolvedInputs.error);
      nav.setSubmitting(false);
      return;
    }

    try {
      const result = await createSchedule({
        name: name.trim(),
        description: description.trim() || null,
        rubricId,
        evalType: "tabular",
        connectionId: connMode === "existing" ? connectionId : null,
        newConnection: connMode === "new" ? buildNewConnection() : null,
        // agent: the fixed input set. dataset: none — rows come from the source.
        inputs: isDataset ? [] : resolvedInputs.rows,
        windowMinutes: isDataset ? windowMinutes : null,
        maxRows: isDataset ? maxRows : null,
        cadence: {
          frequency,
          localHour: frequency === "hourly" ? null : localHour,
          daysOfWeek: frequency === "weekly" ? daysOfWeek : undefined,
          dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
          timezone,
        },
        enabled,
        // resolve() folds in any address still in the input box the user typed but
        // didn't commit via Enter/comma before submitting.
        notificationEmails: emailTags.resolve(),
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

  const selectedRubric = rubrics.find((r) => r.id === rubricId);

  const time = `${String(localHour).padStart(2, "0")}:00`;
  const cadenceSummary =
    frequency === "hourly"
      ? t("cadenceHourly")
      : frequency === "daily"
        ? t("cadenceDaily", { time, timezone })
        : frequency === "weekly"
          ? t("cadenceWeekly", {
              days: daysOfWeek
                .map((d) => dayLabels.find((l) => l.value === d)?.label)
                .join(", "),
              time,
              timezone,
            })
          : t("cadenceMonthly", { day: dayOfMonth, time, timezone });

  // Short model name for the managed System's Review summary — the registry label's lead
  // ("Haiku 4.5 — fastest" → "Haiku 4.5"), so it reads "Prompt (managed, Haiku 4.5)".
  const managedModelLabel = (
    TARGET_MODELS.find((m) => m.id === managedTargetModel)?.label ?? managedTargetModel
  ).split(" — ")[0];

  const systemSummary =
    connMode === "existing"
      ? (selectedConnection?.name ?? "—")
      : connType === CONN_TYPE.managedAgent
        ? t("newConnSuffixManaged", { model: managedModelLabel })
        : connType === CONN_TYPE.posthogDataset
          ? t("newConnSuffixPosthog", { name: connName, projectId: phProjectId })
          : t("newConnSuffixType", { name: connName, type: CONN_TYPE_LABELS[connType] });

  return (
    <WizardShell
      title={t("title")}
      titleId="schedule-wizard-title"
      nav={nav}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={t("submit")}
      submittingLabel={t("submitting")}
    >
      {stepName === STEP.basics && (
        <div className="flex flex-col gap-5">
          <Field label={t("nameLabel")} htmlFor="sched-name">
            <input
              id="sched-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className={inputCls}
            />
          </Field>
          <Field label={t("descriptionLabel")} htmlFor="sched-desc" optional>
            <input
              id="sched-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              className={inputCls}
            />
          </Field>
          <Field label={t("rubricLabel")} htmlFor="sched-rubric">
            <select
              id="sched-rubric"
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
          <Field label={t("evalTypeLabel")} htmlFor="sched-type">
            <input
              id="sched-type"
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
          {/* Only offer "Use existing" when the Team actually has a selectable Connection: a Free
              Team whose only Connections are managed has none, so it goes straight to the create
              flow rather than a dead tab onto an all-disabled dropdown (#294). */}
          {selectableConnections.length > 0 && (
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
                  {m === "existing" ? t("useExisting") : t("newConnection")}
                </button>
              ))}
            </div>
          )}

          {connMode === "existing" ? (
            <>
              <Field label={t("systemConnectionLabel")} htmlFor="sched-conn">
                <select
                  id="sched-conn"
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className={inputCls}
                >
                  {connections.map((c) => {
                    const managed = isManagedConnection(c);
                    return (
                      // Managed Connections are listed but unselectable on Free (#294); the upgrade
                      // CTA below explains why.
                      <option key={c.id} value={c.id} disabled={managed && !managedAllowed}>
                        {managed
                          ? t("connOptionManaged", { name: c.name })
                          : c.kind === "dataset"
                            ? t("connOptionDataset", { name: c.name, provider: c.provider })
                            : t("connOptionAgent", { name: c.name })}
                      </option>
                    );
                  })}
                </select>
              </Field>
              {!managedAllowed && connections.some(isManagedConnection) && <ManagedUpgradeNote />}
            </>
          ) : (
            <>
              {/* Connection type picker */}
              <Field label={t("connTypeLabel")}>
                <div role="group" aria-label={t("connTypeAria")} className="flex flex-wrap gap-1.5">
                  {(Object.keys(CONN_TYPE_LABELS) as ConnType[]).map((ct) => {
                    // The managed "Paste a prompt" System is a paid-plan feature (#294): on Free its
                    // pill is disabled and the upgrade CTA below explains why.
                    const gated = ct === CONN_TYPE.managedAgent && !managedAllowed;
                    return (
                      <button
                        key={ct}
                        type="button"
                        aria-pressed={connType === ct}
                        disabled={gated}
                        title={gated ? t("managedUpgradeTooltip") : undefined}
                        onClick={() => {
                          setConnType(ct);
                          nav.setStepError(null);
                          // Modules are agent-only. Clear them on a switch away so they
                          // can't silently survive and reappear (or ship {{prompt:*}} refs
                          // into a dataset's query template).
                          if (ct !== CONN_TYPE.agent) setModules([]);
                          // Swap the template default to match the type, unless the user
                          // already customized it (custom = query params; agent = request
                          // body). A template carrying {{prompt:*}} Module refs must never
                          // become a dataset query template — those literals would be sent
                          // verbatim to the customer's API — so reset it too.
                          setRequestTemplate((cur) => {
                            if (
                              ct === CONN_TYPE.customDataset &&
                              (cur === DEFAULT_TEMPLATE || extractPromptRefs(cur).length > 0)
                            )
                              return DEFAULT_QUERY_TEMPLATE;
                            if (ct === CONN_TYPE.agent && cur === DEFAULT_QUERY_TEMPLATE)
                              return DEFAULT_TEMPLATE;
                            return cur;
                          });
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                          connType === ct
                            ? "bg-ink text-fg-on-ink"
                            : "border border-hairline-cool bg-card text-ink hover:bg-card-warm"
                        } ${gated ? "cursor-not-allowed opacity-50 hover:bg-card" : ""}`}
                      >
                        {CONN_TYPE_LABELS[ct]}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {!managedAllowed && <ManagedUpgradeNote />}

              {/* A Managed Agent is auto-named server-side from its prompt — no name field. */}
              {connType !== CONN_TYPE.managedAgent && (
                <Field label={t("connNameLabel")} htmlFor="conn-name">
                  <input
                    id="conn-name"
                    type="text"
                    value={connName}
                    onChange={(e) => setConnName(e.target.value)}
                    placeholder={t("connNamePlaceholder")}
                    className={inputCls}
                  />
                </Field>
              )}

              {connType === CONN_TYPE.managedAgent ? (
                <ManagedAgentFields
                  prompt={managedPrompt}
                  setPrompt={setManagedPrompt}
                  targetModel={managedTargetModel}
                  setTargetModel={setManagedTargetModel}
                  idPrefix="sched-managed"
                />
              ) : connType === CONN_TYPE.posthogDataset ? (
                <>
                  <p className="text-xs text-fg-3">
                    {t.rich("posthogIntro", {
                      code: (chunks) => <code className="font-mono">{chunks}</code>,
                      userInput: "user_input",
                      agentOutput: "agent_output",
                      expectedOutput: "expected_output",
                      retrievalContext: "retrieval_context",
                    })}
                  </p>
                  <Field label={t("posthogHostLabel")} htmlFor="ph-host">
                    <input
                      id="ph-host"
                      type="url"
                      value={phHost}
                      onChange={(e) => setPhHost(e.target.value)}
                      placeholder={t("posthogHostPlaceholder")}
                      className={inputCls}
                    />
                  </Field>
                  <EncryptionCallout />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("projectIdLabel")} htmlFor="ph-project">
                      <input
                        id="ph-project"
                        type="text"
                        value={phProjectId}
                        onChange={(e) => setPhProjectId(e.target.value)}
                        placeholder={t("projectIdPlaceholder")}
                        className={inputCls}
                      />
                    </Field>
                    <Field label={t("personalApiKeyLabel")} htmlFor="ph-key">
                      <input
                        id="ph-key"
                        type="password"
                        value={phApiKey}
                        onChange={(e) => setPhApiKey(e.target.value)}
                        placeholder={t("personalApiKeyPlaceholder")}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                  <Field label={t("hogqlLabel")} htmlFor="ph-hogql">
                    <textarea
                      id="ph-hogql"
                      rows={8}
                      value={phHogql}
                      onChange={(e) => setPhHogql(e.target.value)}
                      className={`${inputCls} font-mono text-xs resize-none`}
                    />
                  </Field>
                </>
              ) : connType === CONN_TYPE.customDataset ? (
                <>
                  <p className="text-xs text-fg-3">
                    {t.rich("customDatasetIntro", {
                      code: (chunks) => <code className="font-mono">{chunks}</code>,
                      windowStart: "{{window_start}}",
                      windowEnd: "{{window_end}}",
                      maxRows: "{{max_rows}}",
                    })}
                  </p>
                  <EndpointField
                    value={endpoint}
                    onChange={setEndpoint}
                    placeholder={t("endpointPlaceholderLogs")}
                  />
                  <EncryptionCallout />
                  <AuthFields
                    header={authHeader}
                    onHeaderChange={setAuthHeader}
                    value={authValue}
                    onValueChange={setAuthValue}
                  />
                  <Field label={t("queryParamsLabel")} htmlFor="conn-template">
                    <textarea
                      id="conn-template"
                      rows={5}
                      value={requestTemplate}
                      onChange={(e) => setRequestTemplate(e.target.value)}
                      className={`${inputCls} font-mono text-xs resize-none`}
                    />
                  </Field>
                  <Field label={t("rowsPathLabel")} htmlFor="conn-response-path">
                    <input
                      id="conn-response-path"
                      type="text"
                      value={responsePath}
                      onChange={(e) => setResponsePath(e.target.value)}
                      placeholder={t("rowsPathPlaceholder")}
                      className={`${inputCls} font-mono text-xs`}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("userInputPathLabel")} htmlFor="map-ui">
                      <input
                        id="map-ui"
                        type="text"
                        value={mapUserInput}
                        onChange={(e) => setMapUserInput(e.target.value)}
                        placeholder={t("userInputPathPlaceholder")}
                        className={`${inputCls} font-mono text-xs`}
                      />
                    </Field>
                    <Field label={t("agentOutputPathLabel")} htmlFor="map-ao">
                      <input
                        id="map-ao"
                        type="text"
                        value={mapAgentOutput}
                        onChange={(e) => setMapAgentOutput(e.target.value)}
                        placeholder={t("agentOutputPathPlaceholder")}
                        className={`${inputCls} font-mono text-xs`}
                      />
                    </Field>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-fg-3">
                    {t.rich("agentIntro", {
                      code: (chunks) => <code className="font-mono">{chunks}</code>,
                      userInput: "{{user_input}}",
                      expectedOutput: "{{expected_output}}",
                      retrievalContext: "{{retrieval_context}}",
                    })}
                  </p>
                  <EndpointField
                    value={endpoint}
                    onChange={setEndpoint}
                    placeholder={t("endpointPlaceholderAgent")}
                  />
                  <EncryptionCallout />
                  <AuthFields
                    header={authHeader}
                    onHeaderChange={setAuthHeader}
                    value={authValue}
                    onValueChange={setAuthValue}
                  />
                  {/* Shared Modules editor (#119): optional optimizable Modules + the
                      request template, with live declared↔referenced cross-validation. */}
                  <ModulesEditor
                    modules={modules}
                    onModulesChange={setModules}
                    requestTemplate={requestTemplate}
                    onRequestTemplateChange={setRequestTemplate}
                    idPrefix="conn"
                    optional
                  />
                  <Field label={t("responsePathLabel")} htmlFor="conn-response-path">
                    <input
                      id="conn-response-path"
                      type="text"
                      value={responsePath}
                      onChange={(e) => setResponsePath(e.target.value)}
                      placeholder={t("responsePathPlaceholder")}
                      className={`${inputCls} font-mono text-xs`}
                    />
                  </Field>
                </>
              )}
            </>
          )}
        </div>
      )}

      {stepName === STEP.inputs && (
        <InstanceSourcePicker
          source={instanceSource}
          setSource={(s) => {
            setInstanceSource(s);
            nav.setStepError(null);
          }}
          intro={t("inputsHint")}
          manualRows={inputs}
          setManualRows={setInputs}
          fileName={importFileName}
          fileNote={importFileNote}
          onFile={onInputFile}
          jsonText={jsonText}
          setJsonText={setJsonText}
        />
      )}

      {stepName === STEP.cadence && (
        <div className="flex flex-col gap-5">
          <Field label={t("frequencyLabel")} htmlFor="sched-frequency">
            <select
              id="sched-frequency"
              value={frequency}
              onChange={(e) => changeFrequency(e.target.value as ScheduleFrequency)}
              className={inputCls}
            >
              <option value="hourly">{t("frequencyHourly")}</option>
              <option value="daily">{t("frequencyDaily")}</option>
              <option value="weekly">{t("frequencyWeekly")}</option>
              <option value="monthly">{t("frequencyMonthly")}</option>
            </select>
          </Field>

          {frequency === "weekly" && (
            <Field label={t("runOnLabel")}>
              <div role="group" aria-label={t("runOnAria")} className="flex flex-wrap gap-1.5">
                {dayLabels.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    aria-pressed={daysOfWeek.includes(d.value)}
                    onClick={() => toggleDay(d.value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      daysOfWeek.includes(d.value)
                        ? "bg-ink text-fg-on-ink"
                        : "border border-hairline-cool bg-card text-ink hover:bg-card-warm"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {frequency === "monthly" && (
            <Field label={t("dayOfMonthLabel")} htmlFor="sched-dom">
              <select
                id="sched-dom"
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
                className={inputCls}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {frequency !== "hourly" && (
            <Field label={t("runAtLabel")} htmlFor="sched-hour">
              <select
                id="sched-hour"
                value={localHour}
                onChange={(e) => setLocalHour(Number(e.target.value))}
                className={inputCls}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={t("timezoneLabel")} htmlFor="sched-tz">
            <select
              id="sched-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={inputCls}
            >
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </Field>

          {isDataset && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("lookbackLabel")} htmlFor="sched-window">
                <input
                  id="sched-window"
                  type="number"
                  min={1}
                  value={windowMinutes}
                  onChange={(e) => setWindowMinutes(toCount(e.target.value))}
                  className={inputCls}
                />
              </Field>
              <Field label={t("maxRowsLabel")} htmlFor="sched-maxrows">
                <input
                  id="sched-maxrows"
                  type="number"
                  min={1}
                  value={maxRows}
                  onChange={(e) => setMaxRows(toCount(e.target.value))}
                  className={inputCls}
                />
              </Field>
            </div>
          )}
        </div>
      )}

      {stepName === STEP.notify && (
        <div className="flex flex-col gap-5">
          <Field label={t("recipientsLabel")} htmlFor="sched-email" optional>
            <EmailTagsField id="sched-email" tags={emailTags} />
          </Field>
          <div className="flex items-center justify-between rounded-lg border border-hairline bg-card-warm px-4 py-3">
            <div>
              <p className="text-sm font-medium text-ink">{t("enabledLabel")}</p>
              <p className="text-xs text-fg-3">{t("enabledHint")}</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label={t("enabledLabel")} />
          </div>
        </div>
      )}

      {stepName === STEP.review && (
        <div className="flex flex-col gap-3">
          {nav.submitError && (
            <p role="alert" className="text-sm text-danger-fg">
              {nav.submitError}
            </p>
          )}
          <ReviewRow label={t("reviewName")} value={name} />
          {description.trim() && <ReviewRow label={t("reviewDescription")} value={description} />}
          <ReviewRow label={t("reviewRubric")} value={selectedRubric?.name ?? "—"} />
          <ReviewRow label={t("reviewSystem")} value={systemSummary} />
          {connMode === "new" && connType === CONN_TYPE.agent && cleanModules(modules).length > 0 && (
            <ReviewRow
              label={t("reviewModules")}
              value={cleanModules(modules)
                .map((m) => m.name)
                .join(", ")}
            />
          )}
          {isDataset ? (
            <ReviewRow label={t("reviewSample")} value={t("reviewSampleValue", { minutes: windowMinutes, rows: maxRows })} />
          ) : (
            <ReviewRow
              label={t("reviewInputs")}
              value={t("reviewInputsValue", { count: resolveInputs().rows?.length ?? 0 })}
            />
          )}
          <ReviewRow label={t("reviewCadence")} value={cadenceSummary} />
          <ReviewRow label={t("reviewRecipients")} value={emailTags.resolve().length ? emailTags.resolve().join(", ") : "—"} />
          <ReviewRow label={t("reviewEnabled")} value={enabled ? t("yes") : t("no")} />
        </div>
      )}
    </WizardShell>
  );
}

// The upgrade CTA shown when the Team can't use a Managed Agent (#294): under the existing-System
// picker when a managed Connection is listed-but-gated, and under the type pills where the managed
// pill is disabled. Links to pricing; createSchedule is the server-authoritative gate either way.
function ManagedUpgradeNote() {
  const t = useTranslations("Schedules.wizard");
  return (
    <p className="-mt-2 text-xs text-fg-3">
      {t.rich("managedUpgradeCta", {
        link: (chunks) => (
          <Link href="/pricing" className="font-medium text-accent-ink hover:underline">
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}

function EncryptionCallout() {
  const t = useTranslations("Schedules.wizard");
  return (
    <div className="flex items-start gap-2 rounded-lg border border-hairline bg-paper-warm px-3 py-2.5 text-xs leading-relaxed text-fg-2">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0 text-fg-3"
        aria-hidden="true"
      >
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <span>{t("encryptionCallout")}</span>
    </div>
  );
}

// Endpoint URL field — shared by the agent and custom-dataset branches (only the
// placeholder differs).
function EndpointField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const t = useTranslations("Schedules.wizard");
  return (
    <Field label={t("endpointLabel")} htmlFor="conn-endpoint">
      <input
        id="conn-endpoint"
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
    </Field>
  );
}

// Optional auth header / value pair — identical across the agent and custom-dataset
// branches. The stored value becomes the full header value sent verbatim by the worker.
function AuthFields({
  header,
  onHeaderChange,
  value,
  onValueChange,
}: {
  header: string;
  onHeaderChange: (v: string) => void;
  value: string;
  onValueChange: (v: string) => void;
}) {
  const t = useTranslations("Schedules.wizard");
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t("authHeaderLabel")} htmlFor="conn-auth-header" optional>
        <input
          id="conn-auth-header"
          type="text"
          value={header}
          onChange={(e) => onHeaderChange(e.target.value)}
          placeholder={t("authHeaderPlaceholder")}
          className={inputCls}
        />
      </Field>
      <Field label={t("authValueLabel")} htmlFor="conn-auth-value" optional>
        <input
          id="conn-auth-value"
          type="password"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={t("authValuePlaceholder")}
          className={inputCls}
        />
      </Field>
    </div>
  );
}
