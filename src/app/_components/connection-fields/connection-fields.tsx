"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { inputCls } from "@/app/_components/form-styles";
import { Field } from "@/app/[locale]/(app)/rubrics/_components/field";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import { ModulesEditor } from "@/app/_components/modules-editor";
import { CONN_TYPE, type ConnType } from "@/lib/connections/wizard-constants";
import type { UseConnectionDraft } from "./use-connection-draft";

// The connection-create form body — the type picker plus the per-type field groups — shared by
// the schedule wizard, the Add Connection dialog, and the optimization wizard's inline agent.
// Copy lives in one place (the `Connections.fields` catalog); the host owns the draft state via
// useConnectionDraft and the submit/validation wiring around it.
export function ConnectionFields({
  hook,
  managedAllowed,
  idPrefix,
  showTypePicker = true,
  requireModules = false,
  onClearError,
}: {
  hook: UseConnectionDraft;
  managedAllowed: boolean;
  /** Prefixes every input id so multiple instances on a page keep unique ids. */
  idPrefix: string;
  /** Hide the four-type picker and render only the agent fields (optimization wizard). */
  showTypePicker?: boolean;
  /** Agent Modules are mandatory (an optimization run needs something to tune). */
  requireModules?: boolean;
  /** Called when the user switches type, so the host can clear its step/form error. */
  onClearError?: () => void;
}) {
  const t = useTranslations("Connections.fields");
  const { draft, update, setModules, setRequestTemplate, setConnType } = hook;
  const { connType } = draft;
  const CONN_TYPE_LABELS = useConnTypeLabels();

  return (
    <>
      {showTypePicker && (
        <>
          <Field label={t("connTypeLabel")}>
            <div
              role="group"
              aria-label={t("connTypeAria")}
              className="flex flex-wrap gap-1.5"
            >
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
                      onClearError?.();
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
        </>
      )}

      {/* A Managed Agent is auto-named server-side from its prompt — no name field. */}
      {connType !== CONN_TYPE.managedAgent && (
        <Field label={t("connNameLabel")} htmlFor={`${idPrefix}-name`}>
          <input
            id={`${idPrefix}-name`}
            type="text"
            value={draft.connName}
            onChange={(e) => update({ connName: e.target.value })}
            placeholder={t("connNamePlaceholder")}
            className={inputCls}
          />
        </Field>
      )}

      {connType === CONN_TYPE.managedAgent ? (
        <ManagedAgentFields
          prompt={draft.managedPrompt}
          setPrompt={(v) => update({ managedPrompt: v })}
          targetModel={draft.managedTargetModel}
          setTargetModel={(v) => update({ managedTargetModel: v })}
          idPrefix={`${idPrefix}-managed`}
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
          <Field label={t("posthogHostLabel")} htmlFor={`${idPrefix}-ph-host`}>
            <input
              id={`${idPrefix}-ph-host`}
              type="url"
              value={draft.phHost}
              onChange={(e) => update({ phHost: e.target.value })}
              placeholder={t("posthogHostPlaceholder")}
              className={inputCls}
            />
          </Field>
          <EncryptionCallout />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("projectIdLabel")} htmlFor={`${idPrefix}-ph-project`}>
              <input
                id={`${idPrefix}-ph-project`}
                type="text"
                value={draft.phProjectId}
                onChange={(e) => update({ phProjectId: e.target.value })}
                placeholder={t("projectIdPlaceholder")}
                className={inputCls}
              />
            </Field>
            <Field label={t("personalApiKeyLabel")} htmlFor={`${idPrefix}-ph-key`}>
              <input
                id={`${idPrefix}-ph-key`}
                type="password"
                value={draft.phApiKey}
                onChange={(e) => update({ phApiKey: e.target.value })}
                placeholder={t("personalApiKeyPlaceholder")}
                className={inputCls}
              />
            </Field>
          </div>
          <Field label={t("hogqlLabel")} htmlFor={`${idPrefix}-ph-hogql`}>
            <textarea
              id={`${idPrefix}-ph-hogql`}
              rows={8}
              value={draft.phHogql}
              onChange={(e) => update({ phHogql: e.target.value })}
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
            id={`${idPrefix}-endpoint`}
            value={draft.endpoint}
            onChange={(v) => update({ endpoint: v })}
            placeholder={t("endpointPlaceholderLogs")}
          />
          <EncryptionCallout />
          <AuthFields
            idPrefix={idPrefix}
            header={draft.authHeader}
            onHeaderChange={(v) => update({ authHeader: v })}
            value={draft.authValue}
            onValueChange={(v) => update({ authValue: v })}
          />
          <Field label={t("queryParamsLabel")} htmlFor={`${idPrefix}-template`}>
            <textarea
              id={`${idPrefix}-template`}
              rows={5}
              value={draft.requestTemplate}
              onChange={(e) => setRequestTemplate(e.target.value)}
              className={`${inputCls} font-mono text-xs resize-none`}
            />
          </Field>
          <Field label={t("rowsPathLabel")} htmlFor={`${idPrefix}-response-path`}>
            <input
              id={`${idPrefix}-response-path`}
              type="text"
              value={draft.responsePath}
              onChange={(e) => update({ responsePath: e.target.value })}
              placeholder={t("rowsPathPlaceholder")}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("userInputPathLabel")} htmlFor={`${idPrefix}-map-ui`}>
              <input
                id={`${idPrefix}-map-ui`}
                type="text"
                value={draft.mapUserInput}
                onChange={(e) => update({ mapUserInput: e.target.value })}
                placeholder={t("userInputPathPlaceholder")}
                className={`${inputCls} font-mono text-xs`}
              />
            </Field>
            <Field label={t("agentOutputPathLabel")} htmlFor={`${idPrefix}-map-ao`}>
              <input
                id={`${idPrefix}-map-ao`}
                type="text"
                value={draft.mapAgentOutput}
                onChange={(e) => update({ mapAgentOutput: e.target.value })}
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
            id={`${idPrefix}-endpoint`}
            value={draft.endpoint}
            onChange={(v) => update({ endpoint: v })}
            placeholder={t("endpointPlaceholderAgent")}
          />
          <EncryptionCallout />
          <AuthFields
            idPrefix={idPrefix}
            header={draft.authHeader}
            onHeaderChange={(v) => update({ authHeader: v })}
            value={draft.authValue}
            onValueChange={(v) => update({ authValue: v })}
          />
          {/* Shared Modules editor (#119): optimizable Modules + the request template, with live
              declared↔referenced cross-validation. */}
          <ModulesEditor
            modules={draft.modules}
            onModulesChange={setModules}
            requestTemplate={draft.requestTemplate}
            onRequestTemplateChange={setRequestTemplate}
            idPrefix={idPrefix}
            optional={!requireModules}
          />
          <Field
            label={t("responsePathLabel")}
            htmlFor={`${idPrefix}-response-path`}
          >
            <input
              id={`${idPrefix}-response-path`}
              type="text"
              value={draft.responsePath}
              onChange={(e) => update({ responsePath: e.target.value })}
              placeholder={t("responsePathPlaceholder")}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>
        </>
      )}
    </>
  );
}

// Connection-type display labels keyed off the const set (single source). Insertion order is the
// pill order: the managed "Paste a prompt" System leads (the default, no-setup choice), then the
// live agent, then the dataset types. Shared so the schedule wizard's Review summary names a type
// with the same label the picker shows.
export function useConnTypeLabels(): Record<ConnType, string> {
  const t = useTranslations("Connections.fields");
  return {
    [CONN_TYPE.managedAgent]: t("connType.managedAgent"),
    [CONN_TYPE.agent]: t("connType.agent"),
    [CONN_TYPE.posthogDataset]: t("connType.posthogDataset"),
    [CONN_TYPE.customDataset]: t("connType.customDataset"),
  };
}

// The upgrade CTA shown when the Team can't use a Managed Agent (#294): under the type pills where
// the managed pill is disabled. Links to pricing; the server is the authoritative gate either way.
export function ManagedUpgradeNote() {
  const t = useTranslations("Connections.fields");
  return (
    <p className="-mt-2 text-xs text-fg-3">
      {t.rich("managedUpgradeCta", {
        link: (chunks) => (
          <Link
            href="/pricing"
            className="font-medium text-accent-ink hover:underline"
          >
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}

export function EncryptionCallout() {
  const t = useTranslations("Connections.fields");
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

// Endpoint URL field — shared by the agent and custom-dataset branches (only the placeholder
// differs).
function EndpointField({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const t = useTranslations("Connections.fields");
  return (
    <Field label={t("endpointLabel")} htmlFor={id}>
      <input
        id={id}
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
    </Field>
  );
}

// Optional auth header / value pair — identical across the agent and custom-dataset branches. The
// stored value becomes the full header value sent verbatim by the worker.
function AuthFields({
  idPrefix,
  header,
  onHeaderChange,
  value,
  onValueChange,
}: {
  idPrefix: string;
  header: string;
  onHeaderChange: (v: string) => void;
  value: string;
  onValueChange: (v: string) => void;
}) {
  const t = useTranslations("Connections.fields");
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field
        label={t("authHeaderLabel")}
        htmlFor={`${idPrefix}-auth-header`}
        optional
      >
        <input
          id={`${idPrefix}-auth-header`}
          type="text"
          value={header}
          onChange={(e) => onHeaderChange(e.target.value)}
          placeholder={t("authHeaderPlaceholder")}
          className={inputCls}
        />
      </Field>
      <Field
        label={t("authValueLabel")}
        htmlFor={`${idPrefix}-auth-value`}
        optional
      >
        <input
          id={`${idPrefix}-auth-value`}
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
