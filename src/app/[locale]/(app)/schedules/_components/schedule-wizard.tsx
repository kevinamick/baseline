"use client";

import { useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { WizardShell, useWizardNav } from "@/app/_components/wizard-shell";
import { toCount, ReviewRow } from "@/app/_components/wizard-primitives";
import { inputCls } from "@/app/_components/form-styles";
import { InstanceSourcePicker, emptyInstanceRow, type InstanceSource } from "@/app/_components/instance-rows-editor";
import { EmailTagsField, useEmailTags } from "@/app/_components/email-tags-field";
import { DatasetQueryPreview } from "./dataset-query-preview";
import {
  ConnectionFields,
  ManagedUpgradeNote,
  useConnectionDraft,
  useConnTypeLabels,
  connectionDraftError,
  buildConnectionPayload,
} from "@/app/_components/connection-fields";
import { parseInstancesCsv, parseInstancesJson } from "@/lib/optimization/parse-instances";
import { TARGET_MODELS } from "@/lib/optimization/models";
import { Switch } from "@/app/_components/switch";
import { Field } from "@/app/[locale]/(app)/rubrics/_components/field";
import { createSchedule } from "@/app/actions/schedules";
import { type ScheduleFrequency } from "@/types/schedule";
import { CONN_TYPE } from "@/lib/connections/wizard-constants";
import { endpointUrlError } from "@/lib/connections/endpoint";
import { isAllowedPosthogHostUrl } from "@/lib/connections/posthog-host";
import { isDatasetConnectionType } from "@/lib/validation/schemas";
import { cleanModules } from "@/app/_components/modules-editor";
import type { RubricSummary } from "@/types/rubric";
import type { ConnectionSummary } from "@/types/schedule";
import type { InstanceRow } from "@/types/instances";

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

function isValidJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
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
  // The shared connection-create form's copy lives in its own namespace; used for the inline
  // create validation and the existing-Connection managed-gate message.
  const tFields = useTranslations("Connections.fields");

  // Connection-type display labels for the Review summary — shared with the type picker so a
  // type reads the same in both places.
  const connTypeLabels = useConnTypeLabels();

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
  // Connection-create form state (type + every per-type field), shared with the Add Connection
  // dialog and the optimization wizard via useConnectionDraft. Paid Teams land on the managed
  // "Paste a prompt" create flow by default (the no-setup choice); Free can't use it, so they
  // start on the live-agent type.
  const conn = useConnectionDraft({
    connType: managedAllowed ? CONN_TYPE.managedAgent : CONN_TYPE.agent,
  });
  const { draft } = conn;

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
    connMode === "new"
      ? isDatasetConnectionType(draft.connType)
      : selectedConnection?.kind === "dataset";

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
        if (sel && isManagedConnection(sel) && !managedAllowed)
          return tFields("errManagedPaid");
      } else {
        // The inline create form (managed / agent / posthog / custom) validates identically
        // across surfaces — the shared draft validator (#353).
        const err = connectionDraftError(draft, {
          managedAllowed,
          t: tFields,
          tModules,
        });
        if (err) return err;
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
        newConnection: connMode === "new" ? buildConnectionPayload(draft) : null,
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
    TARGET_MODELS.find((m) => m.id === draft.managedTargetModel)?.label ??
    draft.managedTargetModel
  ).split(" — ")[0];

  const systemSummary =
    connMode === "existing"
      ? (selectedConnection?.name ?? "—")
      : draft.connType === CONN_TYPE.managedAgent
        ? t("newConnSuffixManaged", { model: managedModelLabel })
        : draft.connType === CONN_TYPE.posthogDataset
          ? t("newConnSuffixPosthog", { name: draft.connName, projectId: draft.phProjectId })
          : t("newConnSuffixType", {
              name: draft.connName,
              type: connTypeLabels[draft.connType],
            });

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
              <ConnectionFields
                hook={conn}
                managedAllowed={managedAllowed}
                idPrefix="sched-conn"
                onClearError={() => nav.setStepError(null)}
              />
              {/* Test the query before saving (#39): runs the configured dataset query once
                  against the last hour, mapping the columns so a wrong alias / rows path / auth
                  problem surfaces here instead of in the first scheduled run. */}
              {conn.draft.connType === CONN_TYPE.posthogDataset && (
                <DatasetQueryPreview
                  disabled={
                    !conn.draft.phProjectId.trim() ||
                    !conn.draft.phApiKey.trim() ||
                    !conn.draft.phHogql.trim() ||
                    !isAllowedPosthogHostUrl(conn.draft.phHost)
                  }
                  buildSpec={() => ({
                    type: CONN_TYPE.posthogDataset,
                    host: conn.draft.phHost.trim(),
                    projectId: conn.draft.phProjectId.trim(),
                    apiKey: conn.draft.phApiKey.trim(),
                    hogql: conn.draft.phHogql,
                  })}
                />
              )}
              {conn.draft.connType === CONN_TYPE.customDataset && (
                <DatasetQueryPreview
                  disabled={
                    !!endpointUrlError(conn.draft.endpoint) ||
                    !isValidJson(conn.draft.requestTemplate) ||
                    !conn.draft.responsePath.trim() ||
                    !conn.draft.mapUserInput.trim() ||
                    !conn.draft.mapAgentOutput.trim()
                  }
                  buildSpec={() => ({
                    type: CONN_TYPE.customDataset,
                    endpoint: conn.draft.endpoint.trim(),
                    authHeader: conn.draft.authHeader.trim() || null,
                    authValue: conn.draft.authValue || null,
                    requestTemplate: conn.draft.requestTemplate,
                    responsePath: conn.draft.responsePath.trim(),
                    fieldMap: {
                      userInput: conn.draft.mapUserInput.trim(),
                      agentOutput: conn.draft.mapAgentOutput.trim(),
                    },
                  })}
                />
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
          {connMode === "new" &&
            draft.connType === CONN_TYPE.agent &&
            cleanModules(draft.modules).length > 0 && (
              <ReviewRow
                label={t("reviewModules")}
                value={cleanModules(draft.modules)
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
