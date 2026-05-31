"use client";

import { useState } from "react";
import { Dialog } from "@/app/_components/dialog";
import { Switch } from "@/app/_components/switch";
import { XIcon } from "@/app/_components/icons";
import { Field } from "@/app/rubrics/_components/field";
import { createSchedule } from "@/app/actions/schedules";
import { DAY_LABELS, type ScheduleFrequency } from "@/types/schedule";
import { isAllowedEndpointUrl, ENDPOINT_HTTPS_MESSAGE } from "@/lib/connections/endpoint";
import type { RubricSummary } from "@/types/rubric";
import type { ConnectionSummary } from "@/types/schedule";

interface InputRow {
  userInput: string;
  expectedOutput: string;
  retrievalContext: string;
}

interface Props {
  rubrics: RubricSummary[];
  connections: ConnectionSummary[];
  onClose: () => void;
  onCreated: () => void;
}

const STEPS = ["Basics", "System", "Inputs", "Cadence", "Notify", "Review"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const DEFAULT_TEMPLATE = `{
  "input": "{{user_input}}"
}`;

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

  // Step 1 — Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubricId, setRubricId] = useState(rubrics[0]?.id ?? "");

  // Step 2 — System (Connection)
  const [connMode, setConnMode] = useState<"existing" | "new">(
    connections.length ? "existing" : "new"
  );
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [connName, setConnName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [requestTemplate, setRequestTemplate] = useState(DEFAULT_TEMPLATE);
  const [responsePath, setResponsePath] = useState("output");

  // Step 3 — Inputs
  const [inputs, setInputs] = useState<InputRow[]>([
    { userInput: "", expectedOutput: "", retrievalContext: "" },
  ]);

  // Step 4 — Cadence
  const [frequency, setFrequency] = useState<ScheduleFrequency>("daily");
  const [localHour, setLocalHour] = useState(9);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1, 2, 3, 4, 5]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState(detectTimezone());

  // Step 5 — Notify & enable
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [enabled, setEnabled] = useState(true);

  const tzOptions = timezoneOptions(timezone);

  function commitEmail() {
    const trimmed = emailInput.trim().replace(/,$/, "");
    if (trimmed && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmails((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setEmailInput("");
    }
  }

  function toggleDay(value: number) {
    setDaysOfWeek((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value].sort()
    );
  }

  // Per-step client validation. Returns an error string or null.
  function validateStep(s: number): string | null {
    if (s === 0) {
      if (!name.trim()) return "Give the schedule a name.";
      if (!rubricId) return "Select a rubric.";
    }
    if (s === 1) {
      if (connMode === "existing") {
        if (!connectionId) return "Select a System connection.";
      } else {
        if (!connName.trim()) return "Name the connection.";
        if (!isAllowedEndpointUrl(endpoint)) return ENDPOINT_HTTPS_MESSAGE;
        try {
          JSON.parse(requestTemplate);
        } catch {
          return "Request template must be valid JSON.";
        }
        if (!responsePath.trim()) return "Enter the response path.";
        if (authValue.trim() && !authHeader.trim())
          return "Add an auth header name for the auth value (e.g. Authorization).";
      }
    }
    if (s === 2) {
      if (!inputs.some((r) => r.userInput.trim())) return "Add at least one input row.";
    }
    if (s === 3) {
      if (frequency !== "hourly" && localHour == null) return "Pick an hour.";
      if (frequency === "weekly" && daysOfWeek.length === 0) return "Pick at least one day.";
      if (frequency === "monthly" && !dayOfMonth) return "Pick a day of the month.";
    }
    return null;
  }

  function goNext() {
    const err = validateStep(step);
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

    const result = await createSchedule({
      name: name.trim(),
      description: description.trim() || null,
      rubricId,
      evalType: "tabular",
      connectionId: connMode === "existing" ? connectionId : null,
      newConnection:
        connMode === "new"
          ? {
              name: connName.trim(),
              endpoint: endpoint.trim(),
              authHeader: authHeader.trim() || null,
              authValue: authValue || null,
              requestTemplate,
              responsePath: responsePath.trim(),
            }
          : null,
      inputs: cleanInputs,
      cadence: {
        frequency,
        localHour: frequency === "hourly" ? null : localHour,
        daysOfWeek: frequency === "weekly" ? daysOfWeek : undefined,
        dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
        timezone,
      },
      enabled,
      notificationEmails: emails,
    });

    setSubmitting(false);

    if ("error" in result) {
      setSubmitError(result.error);
      return;
    }
    onCreated();
    onClose();
  }

  const selectedRubric = rubrics.find((r) => r.id === rubricId);
  const selectedConnection = connections.find((c) => c.id === connectionId);

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

          {step === 0 && (
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
                  className={`${inputCls} text-zinc-400 cursor-default select-none`}
                />
              </Field>
            </div>
          )}

          {step === 1 && (
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
                <Field label="System connection" htmlFor="sched-conn">
                  <select
                    id="sched-conn"
                    value={connectionId}
                    onChange={(e) => setConnectionId(e.target.value)}
                    className={inputCls}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {c.endpoint}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <>
                  <p className="text-xs text-zinc-500">
                    Baseline calls your agent once per input. Use{" "}
                    <code className="font-mono">{"{{user_input}}"}</code>,{" "}
                    <code className="font-mono">{"{{expected_output}}"}</code>,{" "}
                    <code className="font-mono">{"{{retrieval_context}}"}</code> in the request body;
                    the response path locates the agent&apos;s output.
                  </p>
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
                  <Field label="Endpoint URL" htmlFor="conn-endpoint">
                    <input
                      id="conn-endpoint"
                      type="url"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder="https://api.example.com/agent"
                      className={inputCls}
                    />
                  </Field>
                  <div className="flex items-start gap-2 rounded-lg border border-hairline bg-paper-warm px-3 py-2.5 text-xs leading-relaxed text-zinc-600">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mt-0.5 shrink-0 text-zinc-500"
                      aria-hidden="true"
                    >
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span>
                      Your credential is encrypted at rest and in transit. It&apos;s never stored
                      in plaintext, never exposed to the browser, and is decrypted only
                      server-side when Baseline calls your agent.
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Auth header" htmlFor="conn-auth-header" optional>
                      <input
                        id="conn-auth-header"
                        type="text"
                        value={authHeader}
                        onChange={(e) => setAuthHeader(e.target.value)}
                        placeholder="Authorization"
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Auth value" htmlFor="conn-auth-value" optional>
                      <input
                        id="conn-auth-value"
                        type="password"
                        value={authValue}
                        onChange={(e) => setAuthValue(e.target.value)}
                        placeholder="Bearer sk-…"
                        className={inputCls}
                      />
                    </Field>
                  </div>
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
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-zinc-500">
                These inputs are fixed. Each run sends them to your System and scores the live
                outputs against the rubric.
              </p>
              {inputs.map((row, i) => (
                <div key={i} className="flex flex-col gap-3 rounded-lg border border-hairline bg-card-warm p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Input {i + 1}
                    </span>
                    <button
                      type="button"
                      disabled={inputs.length === 1}
                      onClick={() => setInputs((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove input ${i + 1}`}
                      className="text-zinc-400 hover:text-red-500 disabled:opacity-0 disabled:pointer-events-none transition-colors text-base leading-none"
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
                className="inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-white px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
              >
                + Add input
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-5">
              <Field label="Frequency" htmlFor="sched-frequency">
                <select
                  id="sched-frequency"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
                  className={inputCls}
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </Field>

              {frequency === "weekly" && (
                <Field label="Run on" htmlFor="">
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_LABELS.map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => toggleDay(d.value)}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                          daysOfWeek.includes(d.value)
                            ? "bg-ink text-white"
                            : "border border-hairline-cool bg-white text-ink hover:bg-card-warm"
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
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col gap-5">
              <Field label="Notification recipients" htmlFor="sched-email" optional>
                <div
                  className="flex min-h-[42px] flex-wrap gap-1.5 rounded-md border border-hairline-field bg-white p-2"
                  onClick={() => document.getElementById("sched-email")?.focus()}
                >
                  {emails.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs text-accent-ink"
                    >
                      {email}
                      <button
                        type="button"
                        onClick={() => setEmails((prev) => prev.filter((e) => e !== email))}
                        aria-label={`Remove ${email}`}
                        className="leading-none text-accent-ink/60 hover:text-accent-ink"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="sched-email"
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
                    className="flex-1 min-w-[160px] bg-transparent text-sm outline-none"
                  />
                </div>
              </Field>
              <div className="flex items-center justify-between rounded-lg border border-hairline bg-card-warm px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-ink">Enabled</p>
                  <p className="text-xs text-zinc-500">When off, the schedule won&apos;t run.</p>
                </div>
                <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="flex flex-col gap-3">
              {submitError && (
                <p role="alert" className="text-sm text-red-600">
                  {submitError}
                </p>
              )}
              <ReviewRow label="Name" value={name} />
              {description.trim() && <ReviewRow label="Description" value={description} />}
              <ReviewRow label="Rubric" value={selectedRubric?.name ?? "—"} />
              <ReviewRow
                label="System"
                value={
                  connMode === "existing"
                    ? (selectedConnection?.name ?? "—")
                    : `${connName} (${endpoint})`
                }
              />
              <ReviewRow label="Inputs" value={`${inputs.filter((r) => r.userInput.trim()).length} row(s)`} />
              <ReviewRow
                label="Cadence"
                value={
                  frequency === "hourly"
                    ? "Every hour"
                    : frequency === "daily"
                      ? `Daily at ${String(localHour).padStart(2, "0")}:00 (${timezone})`
                      : frequency === "weekly"
                        ? `Weekly · ${daysOfWeek
                            .map((d) => DAY_LABELS.find((l) => l.value === d)?.label)
                            .join(", ")} at ${String(localHour).padStart(2, "0")}:00 (${timezone})`
                        : `Monthly · day ${dayOfMonth} at ${String(localHour).padStart(2, "0")}:00 (${timezone})`
                }
              />
              <ReviewRow label="Recipients" value={emails.length ? emails.join(", ") : "—"} />
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
            {submitting ? "Creating…" : "Create schedule"}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-hairline py-2 text-sm last:border-0">
      <span className="w-28 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink">{value}</span>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";
