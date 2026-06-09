"use client";

import { useState } from "react";
import { Dialog } from "@/app/_components/dialog";
import { EmailTagsField, useEmailTags } from "@/app/_components/email-tags-field";
import { Switch } from "@/app/_components/switch";
import { XIcon } from "@/app/_components/icons";
import { Field } from "@/app/rubrics/_components/field";
import { createSchedule } from "@/app/actions/schedules";
import { DAY_LABELS, type ScheduleFrequency } from "@/types/schedule";
import { isAllowedEndpointUrl, ENDPOINT_HTTPS_MESSAGE } from "@/lib/connections/endpoint";
import { isDatasetConnectionType } from "@/lib/validation/schemas";
import type { RubricSummary } from "@/types/rubric";
import type { ConnectionSummary } from "@/types/schedule";

interface InputRow {
  userInput: string;
  expectedOutput: string;
  retrievalContext: string;
}

// Connection-type values — also the discriminator the server's NewConnectionSchema expects.
const CONN_TYPE = {
  agent: "agent",
  customDataset: "custom_dataset",
  posthogDataset: "posthog_dataset",
} as const;

type ConnType = (typeof CONN_TYPE)[keyof typeof CONN_TYPE];

interface Props {
  rubrics: RubricSummary[];
  connections: ConnectionSummary[];
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

const CONN_TYPE_LABELS: Record<ConnType, string> = {
  [CONN_TYPE.agent]: "Live agent",
  [CONN_TYPE.posthogDataset]: "PostHog data source",
  [CONN_TYPE.customDataset]: "Custom data source",
};

// Wizard step names. Inputs is agent-only; dataset shows sampling on Cadence instead, so
// the two flows differ by one step — hence two step lists rather than one.
const STEP = {
  basics: "Basics",
  system: "System",
  inputs: "Inputs",
  cadence: "Cadence",
  notify: "Notify",
  review: "Review",
} as const;

const AGENT_STEPS = [STEP.basics, STEP.system, STEP.inputs, STEP.cadence, STEP.notify, STEP.review];
const DATASET_STEPS = [STEP.basics, STEP.system, STEP.cadence, STEP.notify, STEP.review];

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

// Parse a number-input value to a non-negative integer, mapping blank/NaN to 0 so the
// per-field validation ("Set a lookback window") fires instead of NaN reaching Review
// or the server. 0 is caught by the same validation.
function toCount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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

export function ScheduleWizard({ rubrics, connections, onClose, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"right" | "left">("right");
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Step — Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubricId, setRubricId] = useState(rubrics[0]?.id ?? "");

  // Step — System (Connection)
  const [connMode, setConnMode] = useState<"existing" | "new">(
    connections.length ? "existing" : "new"
  );
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [connType, setConnType] = useState<ConnType>(CONN_TYPE.agent);
  const [connName, setConnName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [requestTemplate, setRequestTemplate] = useState(DEFAULT_TEMPLATE);
  const [responsePath, setResponsePath] = useState("output");
  // Custom dataset field map.
  const [mapUserInput, setMapUserInput] = useState("input");
  const [mapAgentOutput, setMapAgentOutput] = useState("output");
  // PostHog.
  const [phHost, setPhHost] = useState("https://us.posthog.com");
  const [phProjectId, setPhProjectId] = useState("");
  const [phApiKey, setPhApiKey] = useState("");
  const [phHogql, setPhHogql] = useState(DEFAULT_HOGQL);

  // Step — Inputs (agent only)
  const [inputs, setInputs] = useState<InputRow[]>([
    { userInput: "", expectedOutput: "", retrievalContext: "" },
  ]);

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
  const safeStep = Math.min(step, steps.length - 1);
  const stepName = steps[safeStep];

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
      if (!name.trim()) return "Give the schedule a name.";
      if (!rubricId) return "Select a rubric.";
    }
    if (s === STEP.system) {
      if (connMode === "existing") {
        if (!connectionId) return "Select a System connection.";
      } else if (connType === CONN_TYPE.posthogDataset) {
        if (!connName.trim()) return "Name the connection.";
        if (!isAllowedEndpointUrl(phHost)) return ENDPOINT_HTTPS_MESSAGE;
        if (!phProjectId.trim()) return "Enter the PostHog project id.";
        if (!phApiKey.trim()) return "Enter the PostHog API key.";
        if (!phHogql.trim()) return "Enter a HogQL query.";
      } else {
        // agent or custom_dataset
        if (!connName.trim()) return "Name the connection.";
        if (!isAllowedEndpointUrl(endpoint)) return ENDPOINT_HTTPS_MESSAGE;
        try {
          JSON.parse(requestTemplate);
        } catch {
          return connType === CONN_TYPE.agent
            ? "Request template must be valid JSON."
            : "Query template must be valid JSON.";
        }
        if (!responsePath.trim())
          return connType === CONN_TYPE.agent ? "Enter the response path." : "Enter the rows path.";
        if (connType === CONN_TYPE.customDataset && (!mapUserInput.trim() || !mapAgentOutput.trim()))
          return "Map paths for user input and agent output.";
        if (authValue.trim() && !authHeader.trim())
          return "Add an auth header name for the auth value (e.g. Authorization).";
      }
    }
    if (s === STEP.inputs) {
      if (!inputs.some((r) => r.userInput.trim())) return "Add at least one input row.";
    }
    if (s === STEP.cadence) {
      if (frequency !== "hourly" && localHour == null) return "Pick an hour.";
      if (frequency === "weekly" && daysOfWeek.length === 0) return "Pick at least one day.";
      if (frequency === "monthly" && !dayOfMonth) return "Pick a day of the month.";
      if (isDataset) {
        if (!windowMinutes || windowMinutes <= 0) return "Set a lookback window (minutes).";
        if (!maxRows || maxRows <= 0) return "Set a maximum row count.";
      }
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
    setStep((s) => Math.min(s + 1, steps.length - 1));
  }

  function goBack() {
    setStepError(null);
    setDirection("left");
    setStep((s) => Math.max(s - 1, 0));
  }

  function buildNewConnection() {
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
    };
  }

  async function handleSubmit() {
    setSubmitError(null);
    setSubmitting(true);

    const cleanInputs = inputs
      .filter((r) => r.userInput.trim())
      .map((r) => ({
        userInput: r.userInput.trim(),
        expectedOutput: r.expectedOutput.trim() || null,
        retrievalContext: r.retrievalContext.trim() || null,
      }));

    try {
      const result = await createSchedule({
        name: name.trim(),
        description: description.trim() || null,
        rubricId,
        evalType: "tabular",
        connectionId: connMode === "existing" ? connectionId : null,
        newConnection: connMode === "new" ? buildNewConnection() : null,
        // agent: the fixed input set. dataset: none — rows come from the source.
        inputs: isDataset ? [] : cleanInputs,
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
        setSubmitError(result.error);
        return;
      }
      onCreated();
      onClose();
    } catch {
      setSubmitError("Couldn't create the schedule. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedRubric = rubrics.find((r) => r.id === rubricId);

  const cadenceSummary =
    frequency === "hourly"
      ? "Every hour"
      : frequency === "daily"
        ? `Daily at ${String(localHour).padStart(2, "0")}:00 (${timezone})`
        : frequency === "weekly"
          ? `Weekly · ${daysOfWeek
              .map((d) => DAY_LABELS.find((l) => l.value === d)?.label)
              .join(", ")} at ${String(localHour).padStart(2, "0")}:00 (${timezone})`
          : `Monthly · day ${dayOfMonth} at ${String(localHour).padStart(2, "0")}:00 (${timezone})`;

  const systemSummary =
    connMode === "existing"
      ? (selectedConnection?.name ?? "—")
      : connType === CONN_TYPE.posthogDataset
        ? `${connName} (PostHog · project ${phProjectId})`
        : `${connName} (${CONN_TYPE_LABELS[connType]})`;

  return (
    <Dialog onClose={onClose} ariaLabelledBy="schedule-wizard-title" className="max-w-2xl h-[90vh]">
      {/* Header + step progress */}
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 id="schedule-wizard-title" className="text-lg font-semibold tracking-[-0.015em]">
            New schedule
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
        <ol className="mt-4 flex items-center gap-1.5">
          {steps.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium transition-colors ${
                  i === safeStep
                    ? "bg-ink text-fg-on-ink"
                    : i < safeStep
                      ? "bg-accent-soft text-accent-ink"
                      : "bg-paper-warm text-fg-3"
                }`}
              >
                {label}
              </span>
              {i < steps.length - 1 && <span className="text-fg-4">·</span>}
            </li>
          ))}
        </ol>
      </div>

      {/* Body — only the active step is rendered, animated by direction */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div key={safeStep} className={direction === "right" ? "wizard-in-right" : "wizard-in-left"}>
          {stepError && (
            <p role="alert" className="mb-4 text-sm text-danger-fg">
              {stepError}
            </p>
          )}

          {stepName === STEP.basics && (
            <div className="flex flex-col gap-5">
              <Field label="Name" htmlFor="sched-name">
                <input
                  id="sched-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Nightly support-agent eval"
                  className={inputCls}
                />
              </Field>
              <Field label="Description" htmlFor="sched-desc" optional>
                <input
                  id="sched-desc"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this schedule checks"
                  className={inputCls}
                />
              </Field>
              <Field label="Rubric" htmlFor="sched-rubric">
                <select
                  id="sched-rubric"
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
              <Field label="Evaluation type" htmlFor="sched-type">
                <input
                  id="sched-type"
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
                        setStepError(null);
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
                <Field label="System connection" htmlFor="sched-conn">
                  <select
                    id="sched-conn"
                    value={connectionId}
                    onChange={(e) => setConnectionId(e.target.value)}
                    className={inputCls}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {c.kind === "dataset" ? `data source (${c.provider})` : "live agent"}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <>
                  {/* Connection type picker */}
                  <Field label="Connection type">
                    <div role="group" aria-label="Connection type" className="flex flex-wrap gap-1.5">
                      {(Object.keys(CONN_TYPE_LABELS) as ConnType[]).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            setConnType(t);
                            setStepError(null);
                            // Swap the template default to match the type, unless the user
                            // already customized it (custom = query params; agent = request body).
                            setRequestTemplate((cur) => {
                              if (t === CONN_TYPE.customDataset && cur === DEFAULT_TEMPLATE)
                                return DEFAULT_QUERY_TEMPLATE;
                              if (t === CONN_TYPE.agent && cur === DEFAULT_QUERY_TEMPLATE)
                                return DEFAULT_TEMPLATE;
                              return cur;
                            });
                          }}
                          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                            connType === t
                              ? "bg-ink text-fg-on-ink"
                              : "border border-hairline-cool bg-card text-ink hover:bg-card-warm"
                          }`}
                        >
                          {CONN_TYPE_LABELS[t]}
                        </button>
                      ))}
                    </div>
                  </Field>

                  <Field label="Connection name" htmlFor="conn-name">
                    <input
                      id="conn-name"
                      type="text"
                      value={connName}
                      onChange={(e) => setConnName(e.target.value)}
                      placeholder="e.g. Support agent (prod)"
                      className={inputCls}
                    />
                  </Field>

                  {connType === CONN_TYPE.posthogDataset ? (
                    <>
                      <p className="text-xs text-fg-3">
                        Baseline runs a HogQL query against your PostHog project each fire and scores the
                        returned rows. Your query must return columns aliased{" "}
                        <code className="font-mono">user_input</code> and{" "}
                        <code className="font-mono">agent_output</code> (optionally{" "}
                        <code className="font-mono">expected_output</code>,{" "}
                        <code className="font-mono">retrieval_context</code>).
                      </p>
                      <Field label="PostHog host" htmlFor="ph-host">
                        <input
                          id="ph-host"
                          type="url"
                          value={phHost}
                          onChange={(e) => setPhHost(e.target.value)}
                          placeholder="https://us.posthog.com"
                          className={inputCls}
                        />
                      </Field>
                      <EncryptionCallout />
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Project id" htmlFor="ph-project">
                          <input
                            id="ph-project"
                            type="text"
                            value={phProjectId}
                            onChange={(e) => setPhProjectId(e.target.value)}
                            placeholder="12345"
                            className={inputCls}
                          />
                        </Field>
                        <Field label="Personal API key" htmlFor="ph-key">
                          <input
                            id="ph-key"
                            type="password"
                            value={phApiKey}
                            onChange={(e) => setPhApiKey(e.target.value)}
                            placeholder="phx_…"
                            className={inputCls}
                          />
                        </Field>
                      </div>
                      <Field label="HogQL query" htmlFor="ph-hogql">
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
                        Baseline GETs your log/trace API each fire with{" "}
                        <code className="font-mono">{"{{window_start}}"}</code>,{" "}
                        <code className="font-mono">{"{{window_end}}"}</code>,{" "}
                        <code className="font-mono">{"{{max_rows}}"}</code> rendered into the query params,
                        then maps each returned row to our fields.
                      </p>
                      <EndpointField
                        value={endpoint}
                        onChange={setEndpoint}
                        placeholder="https://api.example.com/logs"
                      />
                      <EncryptionCallout />
                      <AuthFields
                        header={authHeader}
                        onHeaderChange={setAuthHeader}
                        value={authValue}
                        onValueChange={setAuthValue}
                      />
                      <Field label="Query params template (JSON)" htmlFor="conn-template">
                        <textarea
                          id="conn-template"
                          rows={5}
                          value={requestTemplate}
                          onChange={(e) => setRequestTemplate(e.target.value)}
                          className={`${inputCls} font-mono text-xs resize-none`}
                        />
                      </Field>
                      <Field label="Rows path" htmlFor="conn-response-path">
                        <input
                          id="conn-response-path"
                          type="text"
                          value={responsePath}
                          onChange={(e) => setResponsePath(e.target.value)}
                          placeholder="data  or  results.items"
                          className={`${inputCls} font-mono text-xs`}
                        />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="user_input path" htmlFor="map-ui">
                          <input
                            id="map-ui"
                            type="text"
                            value={mapUserInput}
                            onChange={(e) => setMapUserInput(e.target.value)}
                            placeholder="prompt"
                            className={`${inputCls} font-mono text-xs`}
                          />
                        </Field>
                        <Field label="agent_output path" htmlFor="map-ao">
                          <input
                            id="map-ao"
                            type="text"
                            value={mapAgentOutput}
                            onChange={(e) => setMapAgentOutput(e.target.value)}
                            placeholder="completion"
                            className={`${inputCls} font-mono text-xs`}
                          />
                        </Field>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-fg-3">
                        Baseline calls your agent once per input. Use{" "}
                        <code className="font-mono">{"{{user_input}}"}</code>,{" "}
                        <code className="font-mono">{"{{expected_output}}"}</code>,{" "}
                        <code className="font-mono">{"{{retrieval_context}}"}</code> in the request body;
                        the response path locates the agent&apos;s output.
                      </p>
                      <EndpointField
                        value={endpoint}
                        onChange={setEndpoint}
                        placeholder="https://api.example.com/agent"
                      />
                      <EncryptionCallout />
                      <AuthFields
                        header={authHeader}
                        onHeaderChange={setAuthHeader}
                        value={authValue}
                        onValueChange={setAuthValue}
                      />
                      <Field label="Request body template (JSON)" htmlFor="conn-template">
                        <textarea
                          id="conn-template"
                          rows={5}
                          value={requestTemplate}
                          onChange={(e) => setRequestTemplate(e.target.value)}
                          className={`${inputCls} font-mono text-xs resize-none`}
                        />
                      </Field>
                      <Field label="Response path" htmlFor="conn-response-path">
                        <input
                          id="conn-response-path"
                          type="text"
                          value={responsePath}
                          onChange={(e) => setResponsePath(e.target.value)}
                          placeholder="output  or  choices.0.message.content"
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
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-3">
                These inputs are fixed. Each run sends them to your System and scores the live
                outputs against the rubric.
              </p>
              {inputs.map((row, i) => (
                <div key={i} className="flex flex-col gap-3 rounded-lg border border-hairline bg-card-warm p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                      Input {i + 1}
                    </span>
                    <button
                      type="button"
                      disabled={inputs.length === 1}
                      onClick={() => setInputs((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove input ${i + 1}`}
                      className="text-fg-4 hover:text-danger disabled:opacity-0 disabled:pointer-events-none transition-colors text-base leading-none"
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    rows={2}
                    value={row.userInput}
                    onChange={(e) =>
                      setInputs((prev) => prev.map((r, j) => (j === i ? { ...r, userInput: e.target.value } : r)))
                    }
                    placeholder="User input…"
                    className={`${inputCls} resize-none`}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <textarea
                      rows={2}
                      value={row.expectedOutput}
                      onChange={(e) =>
                        setInputs((prev) =>
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
                        setInputs((prev) =>
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
                  setInputs((prev) => [...prev, { userInput: "", expectedOutput: "", retrievalContext: "" }])
                }
                className="inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
              >
                + Add input
              </button>
            </div>
          )}

          {stepName === STEP.cadence && (
            <div className="flex flex-col gap-5">
              <Field label="Frequency" htmlFor="sched-frequency">
                <select
                  id="sched-frequency"
                  value={frequency}
                  onChange={(e) => changeFrequency(e.target.value as ScheduleFrequency)}
                  className={inputCls}
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </Field>

              {frequency === "weekly" && (
                <Field label="Run on">
                  <div role="group" aria-label="Run on" className="flex flex-wrap gap-1.5">
                    {DAY_LABELS.map((d) => (
                      <button
                        key={d.value}
                        type="button"
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
                <Field label="Day of month" htmlFor="sched-dom">
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
                <Field label="Run at (local time)" htmlFor="sched-hour">
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

              <Field label="Timezone" htmlFor="sched-tz">
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
                  <Field label="Lookback window (minutes)" htmlFor="sched-window">
                    <input
                      id="sched-window"
                      type="number"
                      min={1}
                      value={windowMinutes}
                      onChange={(e) => setWindowMinutes(toCount(e.target.value))}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Max rows per run" htmlFor="sched-maxrows">
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
              <Field label="Notification recipients" htmlFor="sched-email" optional>
                <EmailTagsField id="sched-email" tags={emailTags} />
              </Field>
              <div className="flex items-center justify-between rounded-lg border border-hairline bg-card-warm px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-ink">Enabled</p>
                  <p className="text-xs text-fg-3">When off, the schedule won&apos;t run.</p>
                </div>
                <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
              </div>
            </div>
          )}

          {stepName === STEP.review && (
            <div className="flex flex-col gap-3">
              {submitError && (
                <p role="alert" className="text-sm text-danger-fg">
                  {submitError}
                </p>
              )}
              <ReviewRow label="Name" value={name} />
              {description.trim() && <ReviewRow label="Description" value={description} />}
              <ReviewRow label="Rubric" value={selectedRubric?.name ?? "—"} />
              <ReviewRow label="System" value={systemSummary} />
              {isDataset ? (
                <ReviewRow label="Sample" value={`Last ${windowMinutes} min · up to ${maxRows} rows`} />
              ) : (
                <ReviewRow label="Inputs" value={`${inputs.filter((r) => r.userInput.trim()).length} row(s)`} />
              )}
              <ReviewRow label="Cadence" value={cadenceSummary} />
              <ReviewRow label="Recipients" value={emailTags.resolve().length ? emailTags.resolve().join(", ") : "—"} />
              <ReviewRow label="Enabled" value={enabled ? "Yes" : "No"} />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-paper-warm px-6 py-3.5">
        <button
          type="button"
          onClick={goBack}
          disabled={safeStep === 0}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm disabled:opacity-40 disabled:hover:bg-card"
        >
          Back
        </button>
        {safeStep < steps.length - 1 ? (
          <button
            type="button"
            onClick={goNext}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Creating…" : "Create schedule"}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function EncryptionCallout() {
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
      <span>
        Your credential is encrypted at rest and in transit. It&apos;s never stored in plaintext,
        never exposed to the browser, and is decrypted only server-side when Baseline reaches your
        system.
      </span>
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
  return (
    <Field label="Endpoint URL" htmlFor="conn-endpoint">
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
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Auth header" htmlFor="conn-auth-header" optional>
        <input
          id="conn-auth-header"
          type="text"
          value={header}
          onChange={(e) => onHeaderChange(e.target.value)}
          placeholder="Authorization"
          className={inputCls}
        />
      </Field>
      <Field label="Auth value" htmlFor="conn-auth-value" optional>
        <input
          id="conn-auth-value"
          type="password"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="Bearer sk-…"
          className={inputCls}
        />
      </Field>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-hairline py-2 text-sm last:border-0">
      <span className="w-28 shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink">{value}</span>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";
