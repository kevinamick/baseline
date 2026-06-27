"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/app/_components/dialog";
import { XIcon } from "@/app/_components/icons";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import { DEFAULT_TARGET_MODEL, type TargetModelId } from "@/lib/optimization/models";
import { inputCls } from "@/app/_components/form-styles";
import { Field } from "@/app/[locale]/(app)/rubrics/_components/field";
import { createConnection } from "@/app/actions/connections";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";

const CONN_TYPE = {
  agent: "agent",
  managedAgent: "managed_agent",
  customDataset: "custom_dataset",
  posthogDataset: "posthog_dataset",
} as const;
type ConnType = (typeof CONN_TYPE)[keyof typeof CONN_TYPE];

const DEFAULT_TEMPLATE = `{
  "input": "{{user_input}}"
}`;

const DEFAULT_QUERY_TEMPLATE = `{
  "from": "{{window_start}}",
  "to": "{{window_end}}",
  "limit": "{{max_rows}}"
}`;

const DEFAULT_HOGQL = `SELECT
  properties.$ai_input AS user_input,
  properties.$ai_output_choices AS agent_output
FROM events
WHERE event = '$ai_generation'
  AND timestamp >= '{{window_start}}'
  AND timestamp <  '{{window_end}}'
LIMIT {{max_rows}}`;

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function AddConnectionDialog({ onClose, onCreated }: Props) {
  const t = useTranslations("Settings.connections");

  const [connType, setConnType] = useState<ConnType>(CONN_TYPE.agent);
  const [connName, setConnName] = useState("");

  // Managed agent
  const [managedPrompt, setManagedPrompt] = useState("");
  const [managedTargetModel, setManagedTargetModel] = useState<string>(DEFAULT_TARGET_MODEL);

  // Agent / dataset shared
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [requestTemplate, setRequestTemplate] = useState(DEFAULT_TEMPLATE);
  const [responsePath, setResponsePath] = useState("output");

  // Agent-only: optional Modules
  const [modules, setModules] = useState<ModuleRow[]>([]);

  // Custom dataset field map
  const [mapUserInput, setMapUserInput] = useState("input");
  const [mapAgentOutput, setMapAgentOutput] = useState("output");

  // PostHog
  const [phHost, setPhHost] = useState("https://us.posthog.com");
  const [phProjectId, setPhProjectId] = useState("");
  const [phApiKey, setPhApiKey] = useState("");
  const [phHogql, setPhHogql] = useState(DEFAULT_HOGQL);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const CONN_TYPE_LABELS: Record<ConnType, string> = {
    [CONN_TYPE.agent]: t("connType.agent"),
    [CONN_TYPE.managedAgent]: t("connType.managedAgent"),
    [CONN_TYPE.posthogDataset]: t("connType.posthogDataset"),
    [CONN_TYPE.customDataset]: t("connType.customDataset"),
  };

  async function handleCreate() {
    setError(null);
    setSaving(true);
    try {
      let input;
      if (connType === CONN_TYPE.managedAgent) {
        if (!managedPrompt.trim()) {
          setError(t("promptRequired"));
          setSaving(false);
          return;
        }
        input = {
          type: "managed_agent" as const,
          prompt: managedPrompt,
          targetModel: managedTargetModel as TargetModelId,
        };
      } else if (connType === CONN_TYPE.posthogDataset) {
        input = {
          type: "posthog_dataset" as const,
          name: connName,
          host: phHost,
          projectId: phProjectId,
          apiKey: phApiKey,
          hogql: phHogql,
        };
      } else if (connType === CONN_TYPE.customDataset) {
        input = {
          type: "custom_dataset" as const,
          name: connName,
          endpoint,
          authHeader: authHeader || null,
          authValue: authValue || null,
          requestTemplate,
          responsePath,
          fieldMap: { userInput: mapUserInput, agentOutput: mapAgentOutput },
        };
      } else {
        // agent
        const mErr = modulesEditorError(modules, requestTemplate, { requireModules: false });
        if (mErr) {
          setError(mErr);
          setSaving(false);
          return;
        }
        input = {
          type: "agent" as const,
          name: connName,
          endpoint,
          authHeader: authHeader || null,
          authValue: authValue || null,
          requestTemplate,
          responsePath,
          optimizablePrompts: cleanModules(modules),
        };
      }

      const result = await createConnection(input);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onCreated();
    } catch {
      setError(t("createFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onClose={onClose} ariaLabelledBy="add-connection-title" className="max-w-2xl max-h-[90dvh]">
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2
            id="add-connection-title"
            className="text-lg font-semibold tracking-[-0.015em]"
          >
            {t("addConnectionTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("closeDialog")}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-fg-2 transition-colors hover:bg-paper hover:text-ink"
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex flex-col gap-5">
          {/* Type picker */}
          <Field label={t("connTypeLabel")}>
            <div role="group" aria-label={t("connTypeAria")} className="flex flex-wrap gap-1.5">
              {(Object.keys(CONN_TYPE_LABELS) as ConnType[]).map((ct) => (
                <button
                  key={ct}
                  type="button"
                  aria-pressed={connType === ct}
                  onClick={() => {
                    setConnType(ct);
                    setError(null);
                    if (ct !== CONN_TYPE.agent) setModules([]);
                    setRequestTemplate((cur) => {
                      if (ct === CONN_TYPE.customDataset && (cur === DEFAULT_TEMPLATE || extractPromptRefs(cur).length > 0))
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
                  }`}
                >
                  {CONN_TYPE_LABELS[ct]}
                </button>
              ))}
            </div>
          </Field>

          {/* Name — managed agent is auto-named from the prompt server-side */}
          {connType !== CONN_TYPE.managedAgent && (
            <Field label={t("connNameLabel")} htmlFor="add-conn-name">
              <input
                id="add-conn-name"
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
              idPrefix="addconn-managed"
            />
          ) : connType === CONN_TYPE.posthogDataset ? (
            <>
              <Field label={t("posthogHostLabel")} htmlFor="add-ph-host">
                <input
                  id="add-ph-host"
                  type="url"
                  value={phHost}
                  onChange={(e) => setPhHost(e.target.value)}
                  placeholder={t("posthogHostPlaceholder")}
                  className={inputCls}
                />
              </Field>
              <EncryptionCallout label={t("encryptionCallout")} />
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("projectIdLabel")} htmlFor="add-ph-project">
                  <input
                    id="add-ph-project"
                    type="text"
                    value={phProjectId}
                    onChange={(e) => setPhProjectId(e.target.value)}
                    placeholder={t("projectIdPlaceholder")}
                    className={inputCls}
                  />
                </Field>
                <Field label={t("personalApiKeyLabel")} htmlFor="add-ph-key">
                  <input
                    id="add-ph-key"
                    type="password"
                    value={phApiKey}
                    onChange={(e) => setPhApiKey(e.target.value)}
                    placeholder={t("personalApiKeyPlaceholder")}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label={t("hogqlLabel")} htmlFor="add-ph-hogql">
                <textarea
                  id="add-ph-hogql"
                  rows={8}
                  value={phHogql}
                  onChange={(e) => setPhHogql(e.target.value)}
                  className={`${inputCls} resize-none font-mono text-xs`}
                />
              </Field>
            </>
          ) : connType === CONN_TYPE.customDataset ? (
            <>
              <Field label={t("endpointLabel")} htmlFor="add-conn-endpoint">
                <input
                  id="add-conn-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={t("endpointPlaceholderLogs")}
                  className={inputCls}
                />
              </Field>
              <EncryptionCallout label={t("encryptionCallout")} />
              <AuthFields
                headerId="add-conn-auth-header"
                header={authHeader}
                onHeaderChange={setAuthHeader}
                headerLabel={t("authHeaderLabel")}
                headerPlaceholder={t("authHeaderPlaceholder")}
                valueId="add-conn-auth-value"
                value={authValue}
                onValueChange={setAuthValue}
                valueLabel={t("authValueLabel")}
                valuePlaceholder={t("authValuePlaceholder")}
              />
              <Field label={t("queryParamsLabel")} htmlFor="add-conn-template">
                <textarea
                  id="add-conn-template"
                  rows={5}
                  value={requestTemplate}
                  onChange={(e) => setRequestTemplate(e.target.value)}
                  className={`${inputCls} resize-none font-mono text-xs`}
                />
              </Field>
              <Field label={t("rowsPathLabel")} htmlFor="add-conn-rows-path">
                <input
                  id="add-conn-rows-path"
                  type="text"
                  value={responsePath}
                  onChange={(e) => setResponsePath(e.target.value)}
                  placeholder={t("rowsPathPlaceholder")}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("userInputPathLabel")} htmlFor="add-map-ui">
                  <input
                    id="add-map-ui"
                    type="text"
                    value={mapUserInput}
                    onChange={(e) => setMapUserInput(e.target.value)}
                    placeholder={t("userInputPathPlaceholder")}
                    className={`${inputCls} font-mono text-xs`}
                  />
                </Field>
                <Field label={t("agentOutputPathLabel")} htmlFor="add-map-ao">
                  <input
                    id="add-map-ao"
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
            // Live agent
            <>
              <Field label={t("endpointLabel")} htmlFor="add-conn-endpoint">
                <input
                  id="add-conn-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={t("endpointPlaceholderAgent")}
                  className={inputCls}
                />
              </Field>
              <EncryptionCallout label={t("encryptionCallout")} />
              <AuthFields
                headerId="add-conn-auth-header"
                header={authHeader}
                onHeaderChange={setAuthHeader}
                headerLabel={t("authHeaderLabel")}
                headerPlaceholder={t("authHeaderPlaceholder")}
                valueId="add-conn-auth-value"
                value={authValue}
                onValueChange={setAuthValue}
                valueLabel={t("authValueLabel")}
                valuePlaceholder={t("authValuePlaceholder")}
              />
              <ModulesEditor
                modules={modules}
                onModulesChange={setModules}
                requestTemplate={requestTemplate}
                onRequestTemplateChange={setRequestTemplate}
                idPrefix="addconn"
                optional
              />
              <Field label={t("responsePathLabel")} htmlFor="add-conn-response-path">
                <input
                  id="add-conn-response-path"
                  type="text"
                  value={responsePath}
                  onChange={(e) => setResponsePath(e.target.value)}
                  placeholder={t("responsePathPlaceholder")}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-hairline bg-paper-warm px-6 py-3.5">
        {error && (
          <p role="alert" className="min-w-0 flex-1 text-sm text-danger-fg">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={saving}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? t("creating") : t("createConnection")}
        </button>
      </div>
    </Dialog>
  );
}

function EncryptionCallout({ label }: { label: string }) {
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
      <span>{label}</span>
    </div>
  );
}

function AuthFields({
  headerId,
  header,
  onHeaderChange,
  headerLabel,
  headerPlaceholder,
  valueId,
  value,
  onValueChange,
  valueLabel,
  valuePlaceholder,
}: {
  headerId: string;
  header: string;
  onHeaderChange: (v: string) => void;
  headerLabel: string;
  headerPlaceholder: string;
  valueId: string;
  value: string;
  onValueChange: (v: string) => void;
  valueLabel: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={headerLabel} htmlFor={headerId} optional>
        <input
          id={headerId}
          type="text"
          value={header}
          onChange={(e) => onHeaderChange(e.target.value)}
          placeholder={headerPlaceholder}
          className={inputCls}
        />
      </Field>
      <Field label={valueLabel} htmlFor={valueId} optional>
        <input
          id={valueId}
          type="password"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={valuePlaceholder}
          className={inputCls}
        />
      </Field>
    </div>
  );
}
