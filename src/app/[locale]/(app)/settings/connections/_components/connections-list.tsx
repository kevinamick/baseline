"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Dialog } from "@/app/_components/dialog";
import { inputCls } from "@/app/_components/form-styles";
import { PlusIcon, TrashIcon, XIcon } from "@/app/_components/icons";
import { Field } from "@/app/[locale]/(app)/rubrics/_components/field";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import {
  DEFAULT_TARGET_MODEL,
  type TargetModelId,
} from "@/lib/optimization/models";
import {
  createConnection,
  updateConnectionModules,
  updateManagedConnection,
  deleteConnection,
  getConnectionDeletionImpact,
  type ConnectionDeletionImpact,
} from "@/app/actions/connections";
import { endpointUrlError } from "@/lib/connections/endpoint";
import {
  isAllowedPosthogHostUrl,
  POSTHOG_HOST_MESSAGE,
} from "@/lib/connections/posthog-host";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";

// List-row shape for the Connections settings surface. requestTemplate is the stored jsonb
// pretty-printed back to a string (the editor and the cross-validation work on strings).
export interface EditableConnection {
  id: string;
  name: string;
  kind: "agent" | "dataset";
  // "managed" = a "Paste a prompt" System (runs on the managed LLM, edits a prompt + target model);
  // "external" = an HTTP agent or a dataset (edits Modules + request template). (#294)
  agentKind: "external" | "managed";
  provider: string;
  endpoint: string;
  targetModel: string | null;
  requestTemplate: string;
  modules: { name: string; seed: string }[];
}

interface Props {
  connections: EditableConnection[];
  canWrite: boolean;
  /** Paid plans can create a Managed Agent System; Free sees it disabled with an upgrade CTA. */
  managedAllowed: boolean;
}

// The connection management surface (#119, #353): a read-only list of the team's Connections
// with an "Edit Modules" dialog on agent rows, plus an "Add connection" dialog that creates a
// new Connection directly from this page. Editing reuses the shared ModulesEditor — the same
// rows + template + declared↔referenced cross-validation as both create wizards.
export function ConnectionsList({
  connections,
  canWrite,
  managedAllowed,
}: Props) {
  const router = useRouter();
  const t = useTranslations("Settings.connections");
  const [editing, setEditing] = useState<EditableConnection | null>(null);
  const [deleting, setDeleting] = useState<EditableConnection | null>(null);
  const [adding, setAdding] = useState(false);

  const addButton = canWrite && (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
    >
      <PlusIcon size={15} />
      {t("create.button")}
    </button>
  );

  if (connections.length === 0) {
    return (
      <>
        <p className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 text-sm text-fg-3">
          {t("empty")}
        </p>
        {addButton}
        {adding && (
          <AddConnectionDialog
            managedAllowed={managedAllowed}
            onClose={() => setAdding(false)}
            onCreated={() => {
              setAdding(false);
              router.refresh();
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      {addButton}
      <ul className="mt-4 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card">
        {connections.map((conn) => (
          <li
            key={conn.id}
            className="flex items-center justify-between gap-4 p-4"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">
                {conn.name}
              </p>
              <p className="mt-0.5 truncate text-xs text-fg-3">
                {conn.kind === "dataset"
                  ? t("dataSource", { provider: conn.provider })
                  : conn.agentKind === "managed"
                    ? t("managedAgent")
                    : t("liveAgent")}
                {/* A managed agent has no endpoint (it runs on the managed LLM). */}
                {conn.agentKind !== "managed" && conn.endpoint
                  ? ` · ${conn.endpoint}`
                  : null}
              </p>
              {conn.kind === "agent" && conn.agentKind !== "managed" && (
                <p className="mt-1 text-xs text-fg-3">
                  {conn.modules.length > 0 ? (
                    <>
                      {t("modulesLabel")}
                      {conn.modules.map((m) => (
                        <code
                          key={m.name}
                          className="mr-1 font-mono text-[11px] text-ink"
                        >
                          {m.name}
                        </code>
                      ))}
                    </>
                  ) : (
                    t("noModules")
                  )}
                </p>
              )}
            </div>
            {canWrite && (
              <div className="flex shrink-0 items-center gap-2">
                {conn.kind === "agent" && (
                  <button
                    type="button"
                    onClick={() => setEditing(conn)}
                    className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
                  >
                    {conn.agentKind === "managed"
                      ? t("editPrompt")
                      : t("editModules")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDeleting(conn)}
                  aria-label={t("deleteAria", { name: conn.name })}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-fg-3 transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40"
                >
                  <TrashIcon size={15} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing &&
        (editing.agentKind === "managed" ? (
          <EditManagedDialog
            connection={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        ) : (
          <EditModulesDialog
            connection={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        ))}

      {deleting && (
        <DeleteConnectionDialog
          connection={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      )}

      {adding && (
        <AddConnectionDialog
          managedAllowed={managedAllowed}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

// Counts → a human phrase for the confirm body, e.g. "2 schedules and 1 past optimization run".
// Only reached when the delete is unblocked, so every counted run is terminal ("past").
function describeDependents(
  impact: ConnectionDeletionImpact,
  t: ReturnType<typeof useTranslations<"Settings.connections">>,
): string {
  const schedules =
    impact.schedules > 0
      ? t("dependentSchedules", { count: impact.schedules })
      : null;
  const runs =
    impact.optimizationRuns > 0
      ? t("dependentRuns", { count: impact.optimizationRuns })
      : null;
  if (schedules && runs) return t("dependentJoin", { schedules, runs });
  return schedules ?? runs ?? "";
}

// Destructive-action confirm for deleting a Connection. A custom inline modal (not the shared
// Dialog) so Esc does NOT dismiss it — the same guardrail the rubric delete uses. On open it
// loads the cascade impact: an active run / enabled schedule blocks the delete (Close only),
// otherwise it warns about what cascades and gates on a two-press "Delete forever?". (#225)
function DeleteConnectionDialog({
  connection,
  onClose,
  onDeleted,
}: {
  connection: EditableConnection;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("Settings.connections");
  const [impact, setImpact] = useState<ConnectionDeletionImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    getConnectionDeletionImpact(connection.id)
      .then((result) => {
        if (!active) return;
        if ("error" in result) {
          setError(result.error);
        } else {
          setImpact(result);
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError(t("checkFailed"));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [connection.id, t]);

  const blocked = impact?.blockReason != null;

  async function handleDelete() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    setDeleting(true);
    try {
      const result = await deleteConnection(connection.id);
      if ("error" in result) {
        // A run/schedule may have gone live between the impact check and the delete; the
        // server re-checks and we surface that here, resetting the two-press escalation.
        setError(result.error);
        setConfirming(false);
        return;
      }
      onDeleted();
    } catch {
      setError(t("deleteFailed"));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-overlay" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-hairline-cool bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
          <h3 className="text-lg font-semibold tracking-[-0.015em]">
            {t("deleteTitle")}
          </h3>
        </div>
        <div className="flex flex-col gap-1.5 px-6 py-5">
          {loading ? (
            <p className="text-sm text-fg-3">{t("deleteChecking")}</p>
          ) : blocked ? (
            <p className="text-sm leading-normal text-ink">
              {impact?.blockReason}
            </p>
          ) : (
            <>
              <p className="text-sm leading-normal text-ink">
                {t.rich("deleteBody", {
                  name: connection.name,
                  strong: (chunks) => (
                    <span className="font-semibold">{chunks}</span>
                  ),
                })}
              </p>
              {impact &&
                (impact.schedules > 0 || impact.optimizationRuns > 0) && (
                  <p className="text-[13px] text-fg-3">
                    {t("deleteDependents", {
                      dependents: describeDependents(impact, t),
                    })}
                  </p>
                )}
              <p className="text-[13px] text-fg-3">{t("deleteIrreversible")}</p>
            </>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger-fg">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2.5 border-t border-hairline bg-paper-warm px-6 py-3.5">
          <button
            onClick={onClose}
            className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
          >
            {blocked ? t("close") : t("cancel")}
          </button>
          {!blocked && (
            <button
              onClick={handleDelete}
              disabled={loading || deleting}
              className="rounded-full bg-danger px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-hover disabled:opacity-50"
            >
              {deleting
                ? t("deleting")
                : confirming
                  ? t("deleteConfirm")
                  : t("delete")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EditModulesDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: EditableConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Settings.connections");
  const [modules, setModules] = useState<ModuleRow[]>(connection.modules);
  const [requestTemplate, setRequestTemplate] = useState(
    connection.requestTemplate,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    try {
      JSON.parse(requestTemplate);
    } catch {
      setError(t("invalidJson"));
      return;
    }
    // Same Modules rules as the wizards; optional here — clearing all Modules is allowed
    // (it returns the agent to the plain {{user_input}}-only shape).
    const mErr = modulesEditorError(modules, requestTemplate, {
      requireModules: false,
    });
    if (mErr) {
      setError(mErr);
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const result = await updateConnectionModules({
        connectionId: connection.id,
        requestTemplate,
        modules: cleanModules(modules),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onSaved();
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      ariaLabelledBy="edit-modules-title"
      className="max-w-2xl max-h-[90dvh]"
    >
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2
            id="edit-modules-title"
            className="min-w-0 truncate text-lg font-semibold tracking-[-0.015em]"
          >
            {t("editTitle", { name: connection.name })}
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
          <p className="text-xs text-fg-3">
            {t.rich("editBlurb", {
              ref: "{{prompt:<name>}}",
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </p>
          <ModulesEditor
            modules={modules}
            onModulesChange={setModules}
            requestTemplate={requestTemplate}
            onRequestTemplateChange={setRequestTemplate}
            idPrefix="editconn"
            optional
          />
        </div>
      </div>

      {/* The error lives beside the footer actions: the body scrolls (max-h-[90vh]) and a
          top-of-body alert can sit off-screen when Save is clicked from the sticky footer. */}
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
          onClick={handleSave}
          disabled={saving}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? t("saving") : t("saveModules")}
        </button>
      </div>
    </Dialog>
  );
}

// Edit a Managed Agent ("Paste a prompt") Connection (#294): just the prompt and target model.
// No request template and no Modules editor — a managed Connection's single Module's seed IS the
// prompt, so it can't go through the template-coupled EditModulesDialog (its cross-check would
// reject the lone "prompt" Module as unreferenced).
function EditManagedDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: EditableConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Settings.connections");
  const [prompt, setPrompt] = useState(connection.modules[0]?.seed ?? "");
  const [targetModel, setTargetModel] = useState<string>(
    connection.targetModel ?? DEFAULT_TARGET_MODEL,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!prompt.trim()) {
      setError(t("promptRequired"));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await updateManagedConnection({
        connectionId: connection.id,
        prompt,
        // The dropdown's options are exactly the registry ids; the server re-validates regardless.
        targetModel: targetModel as TargetModelId,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onSaved();
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      ariaLabelledBy="edit-prompt-title"
      className="max-w-2xl max-h-[90dvh]"
    >
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2
            id="edit-prompt-title"
            className="min-w-0 truncate text-lg font-semibold tracking-[-0.015em]"
          >
            {t("editPromptTitle", { name: connection.name })}
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
        <ManagedAgentFields
          prompt={prompt}
          setPrompt={setPrompt}
          targetModel={targetModel}
          setTargetModel={setTargetModel}
          idPrefix="editmanaged"
        />
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
          onClick={handleSave}
          disabled={saving}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? t("saving") : t("savePrompt")}
        </button>
      </div>
    </Dialog>
  );
}

// Connection-type values — the discriminator NewConnectionSchema expects (mirrors the
// schedule wizard's CONN_TYPE).
const CREATE_CONN_TYPE = {
  managedAgent: "managed_agent",
  agent: "agent",
  posthogDataset: "posthog_dataset",
  customDataset: "custom_dataset",
} as const;

type CreateConnType = (typeof CREATE_CONN_TYPE)[keyof typeof CREATE_CONN_TYPE];

const DEFAULT_AGENT_TEMPLATE = `{
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

function EncryptionCallout({
  t,
}: {
  t: ReturnType<typeof useTranslations<"Settings.connections.create">>;
}) {
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

function ManagedUpgradeNote({
  t,
}: {
  t: ReturnType<typeof useTranslations<"Settings.connections.create">>;
}) {
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

// Create a new Connection directly from the Connections settings page (#353). Mirrors the
// schedule wizard's connection-create form — the same four types, the same shared field
// components (ModulesEditor, ManagedAgentFields), and the same client-side validation that
// feeds createConnection (the server action both wizards already use).
function AddConnectionDialog({
  managedAllowed,
  onClose,
  onCreated,
}: {
  managedAllowed: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("Settings.connections.create");
  const tModules = useTranslations("Modules");
  const [connType, setConnType] = useState<CreateConnType>(
    managedAllowed ? CREATE_CONN_TYPE.managedAgent : CREATE_CONN_TYPE.agent,
  );
  // Managed "Paste a prompt" fields (#294): just the prompt and the model it runs on.
  const [managedPrompt, setManagedPrompt] = useState("");
  const [managedTargetModel, setManagedTargetModel] =
    useState<string>(DEFAULT_TARGET_MODEL);
  // Shared agent / custom-dataset fields.
  const [connName, setConnName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const [requestTemplate, setRequestTemplate] = useState(
    DEFAULT_AGENT_TEMPLATE,
  );
  const [responsePath, setResponsePath] = useState("output");
  // Agent-only: optional optimizable Modules.
  const [modules, setModules] = useState<ModuleRow[]>([]);
  // Custom dataset field map.
  const [mapUserInput, setMapUserInput] = useState("input");
  const [mapAgentOutput, setMapAgentOutput] = useState("output");
  // PostHog.
  const [phHost, setPhHost] = useState("https://us.posthog.com");
  const [phProjectId, setPhProjectId] = useState("");
  const [phApiKey, setPhApiKey] = useState("");
  const [phHogql, setPhHogql] = useState(DEFAULT_HOGQL);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const CONN_TYPE_LABELS: Record<CreateConnType, string> = {
    [CREATE_CONN_TYPE.managedAgent]: t("connType.managedAgent"),
    [CREATE_CONN_TYPE.agent]: t("connType.agent"),
    [CREATE_CONN_TYPE.posthogDataset]: t("connType.posthogDataset"),
    [CREATE_CONN_TYPE.customDataset]: t("connType.customDataset"),
  };

  function validate(): string | null {
    if (connType === CREATE_CONN_TYPE.managedAgent) {
      if (!managedAllowed) return t("errManagedPaid");
      if (!managedPrompt.trim()) return t("errPrompt");
      return null;
    }
    if (connType === CREATE_CONN_TYPE.posthogDataset) {
      if (!connName.trim()) return t("errNameConnection");
      const phHostError = endpointUrlError(phHost);
      if (phHostError) return phHostError;
      if (!isAllowedPosthogHostUrl(phHost)) return POSTHOG_HOST_MESSAGE;
      if (!phProjectId.trim()) return t("errProjectId");
      if (!phApiKey.trim()) return t("errApiKey");
      if (!phHogql.trim()) return t("errHogql");
      return null;
    }
    // agent or custom_dataset
    if (!connName.trim()) return t("errNameConnection");
    const endpointError = endpointUrlError(endpoint);
    if (endpointError) return endpointError;
    try {
      JSON.parse(requestTemplate);
    } catch {
      return connType === CREATE_CONN_TYPE.agent
        ? t("errRequestTemplateJson")
        : t("errQueryTemplateJson");
    }
    if (!responsePath.trim())
      return connType === CREATE_CONN_TYPE.agent
        ? t("errResponsePath")
        : t("errRowsPath");
    if (
      connType === CREATE_CONN_TYPE.customDataset &&
      (!mapUserInput.trim() || !mapAgentOutput.trim())
    )
      return t("errMapPaths");
    if (
      connType === CREATE_CONN_TYPE.customDataset &&
      extractPromptRefs(requestTemplate).length > 0
    )
      return t("errPromptRefDataset");
    if (authValue.trim() && !authHeader.trim()) return t("errAuthHeader");
    if (connType === CREATE_CONN_TYPE.agent) {
      const mErr = modulesEditorError(
        modules,
        requestTemplate,
        { requireModules: false },
        tModules,
      );
      if (mErr) return mErr;
    }
    return null;
  }

  function buildPayload() {
    if (connType === CREATE_CONN_TYPE.managedAgent) {
      return {
        type: CREATE_CONN_TYPE.managedAgent,
        targetModel: managedTargetModel as TargetModelId,
        prompt: managedPrompt.trim(),
      };
    }
    if (connType === CREATE_CONN_TYPE.posthogDataset) {
      return {
        type: CREATE_CONN_TYPE.posthogDataset,
        name: connName.trim(),
        host: phHost.trim(),
        projectId: phProjectId.trim(),
        apiKey: phApiKey.trim(),
        hogql: phHogql,
      };
    }
    if (connType === CREATE_CONN_TYPE.customDataset) {
      return {
        type: CREATE_CONN_TYPE.customDataset,
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
      type: CREATE_CONN_TYPE.agent,
      name: connName.trim(),
      endpoint: endpoint.trim(),
      authHeader: authHeader.trim() || null,
      authValue: authValue || null,
      requestTemplate,
      responsePath: responsePath.trim(),
      optimizablePrompts: cleanModules(modules),
    };
  }

  async function handleCreate() {
    const vErr = validate();
    if (vErr) {
      setError(vErr);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await createConnection(buildPayload());
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onCreated();
    } catch {
      setError(t("errCreateFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      ariaLabelledBy="add-conn-title"
      className="max-w-2xl max-h-[90dvh]"
    >
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2
            id="add-conn-title"
            className="min-w-0 truncate text-lg font-semibold tracking-[-0.015em]"
          >
            {t("title")}
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
          <p className="text-xs text-fg-3">{t("blurb")}</p>

          <Field label={t("connTypeLabel")}>
            <div
              role="group"
              aria-label={t("connTypeAria")}
              className="flex flex-wrap gap-1.5"
            >
              {(Object.keys(CONN_TYPE_LABELS) as CreateConnType[]).map((ct) => {
                const gated =
                  ct === CREATE_CONN_TYPE.managedAgent && !managedAllowed;
                return (
                  <button
                    key={ct}
                    type="button"
                    aria-pressed={connType === ct}
                    disabled={gated}
                    title={gated ? t("managedUpgradeTooltip") : undefined}
                    onClick={() => {
                      setConnType(ct);
                      setError(null);
                      if (ct !== CREATE_CONN_TYPE.agent) setModules([]);
                      setRequestTemplate((cur) => {
                        if (
                          ct === CREATE_CONN_TYPE.customDataset &&
                          (cur === DEFAULT_AGENT_TEMPLATE ||
                            extractPromptRefs(cur).length > 0)
                        )
                          return DEFAULT_QUERY_TEMPLATE;
                        if (
                          ct === CREATE_CONN_TYPE.agent &&
                          cur === DEFAULT_QUERY_TEMPLATE
                        )
                          return DEFAULT_AGENT_TEMPLATE;
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

          {!managedAllowed && <ManagedUpgradeNote t={t} />}

          {connType !== CREATE_CONN_TYPE.managedAgent && (
            <Field label={t("connNameLabel")} htmlFor="addconn-name">
              <input
                id="addconn-name"
                type="text"
                value={connName}
                onChange={(e) => setConnName(e.target.value)}
                placeholder={t("connNamePlaceholder")}
                className={inputCls}
              />
            </Field>
          )}

          {connType === CREATE_CONN_TYPE.managedAgent ? (
            <ManagedAgentFields
              prompt={managedPrompt}
              setPrompt={setManagedPrompt}
              targetModel={managedTargetModel}
              setTargetModel={setManagedTargetModel}
              idPrefix="addconn-managed"
            />
          ) : connType === CREATE_CONN_TYPE.posthogDataset ? (
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
              <Field label={t("posthogHostLabel")} htmlFor="addconn-ph-host">
                <input
                  id="addconn-ph-host"
                  type="url"
                  value={phHost}
                  onChange={(e) => setPhHost(e.target.value)}
                  placeholder={t("posthogHostPlaceholder")}
                  className={inputCls}
                />
              </Field>
              <EncryptionCallout t={t} />
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("projectIdLabel")} htmlFor="addconn-ph-project">
                  <input
                    id="addconn-ph-project"
                    type="text"
                    value={phProjectId}
                    onChange={(e) => setPhProjectId(e.target.value)}
                    placeholder={t("projectIdPlaceholder")}
                    className={inputCls}
                  />
                </Field>
                <Field
                  label={t("personalApiKeyLabel")}
                  htmlFor="addconn-ph-key"
                >
                  <input
                    id="addconn-ph-key"
                    type="password"
                    value={phApiKey}
                    onChange={(e) => setPhApiKey(e.target.value)}
                    placeholder={t("personalApiKeyPlaceholder")}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label={t("hogqlLabel")} htmlFor="addconn-ph-hogql">
                <textarea
                  id="addconn-ph-hogql"
                  rows={8}
                  value={phHogql}
                  onChange={(e) => setPhHogql(e.target.value)}
                  className={`${inputCls} font-mono text-xs resize-none`}
                />
              </Field>
            </>
          ) : connType === CREATE_CONN_TYPE.customDataset ? (
            <>
              <p className="text-xs text-fg-3">
                {t.rich("customDatasetIntro", {
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                  windowStart: "{{window_start}}",
                  windowEnd: "{{window_end}}",
                  maxRows: "{{max_rows}}",
                })}
              </p>
              <Field label={t("endpointLabel")} htmlFor="addconn-endpoint">
                <input
                  id="addconn-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={t("endpointPlaceholderLogs")}
                  className={inputCls}
                />
              </Field>
              <EncryptionCallout t={t} />
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label={t("authHeaderLabel")}
                  htmlFor="addconn-auth-header"
                  optional
                >
                  <input
                    id="addconn-auth-header"
                    type="text"
                    value={authHeader}
                    onChange={(e) => setAuthHeader(e.target.value)}
                    placeholder={t("authHeaderPlaceholder")}
                    className={inputCls}
                  />
                </Field>
                <Field
                  label={t("authValueLabel")}
                  htmlFor="addconn-auth-value"
                  optional
                >
                  <input
                    id="addconn-auth-value"
                    type="password"
                    value={authValue}
                    onChange={(e) => setAuthValue(e.target.value)}
                    placeholder={t("authValuePlaceholder")}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label={t("queryParamsLabel")} htmlFor="addconn-template">
                <textarea
                  id="addconn-template"
                  rows={5}
                  value={requestTemplate}
                  onChange={(e) => setRequestTemplate(e.target.value)}
                  className={`${inputCls} font-mono text-xs resize-none`}
                />
              </Field>
              <Field label={t("rowsPathLabel")} htmlFor="addconn-response-path">
                <input
                  id="addconn-response-path"
                  type="text"
                  value={responsePath}
                  onChange={(e) => setResponsePath(e.target.value)}
                  placeholder={t("rowsPathPlaceholder")}
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("userInputPathLabel")} htmlFor="addconn-map-ui">
                  <input
                    id="addconn-map-ui"
                    type="text"
                    value={mapUserInput}
                    onChange={(e) => setMapUserInput(e.target.value)}
                    placeholder={t("userInputPathPlaceholder")}
                    className={`${inputCls} font-mono text-xs`}
                  />
                </Field>
                <Field
                  label={t("agentOutputPathLabel")}
                  htmlFor="addconn-map-ao"
                >
                  <input
                    id="addconn-map-ao"
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
              <Field label={t("endpointLabel")} htmlFor="addconn-endpoint">
                <input
                  id="addconn-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={t("endpointPlaceholderAgent")}
                  className={inputCls}
                />
              </Field>
              <EncryptionCallout t={t} />
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label={t("authHeaderLabel")}
                  htmlFor="addconn-auth-header"
                  optional
                >
                  <input
                    id="addconn-auth-header"
                    type="text"
                    value={authHeader}
                    onChange={(e) => setAuthHeader(e.target.value)}
                    placeholder={t("authHeaderPlaceholder")}
                    className={inputCls}
                  />
                </Field>
                <Field
                  label={t("authValueLabel")}
                  htmlFor="addconn-auth-value"
                  optional
                >
                  <input
                    id="addconn-auth-value"
                    type="password"
                    value={authValue}
                    onChange={(e) => setAuthValue(e.target.value)}
                    placeholder={t("authValuePlaceholder")}
                    className={inputCls}
                  />
                </Field>
              </div>
              <ModulesEditor
                modules={modules}
                onModulesChange={setModules}
                requestTemplate={requestTemplate}
                onRequestTemplateChange={setRequestTemplate}
                idPrefix="addconn"
                optional
              />
              <Field
                label={t("responsePathLabel")}
                htmlFor="addconn-response-path"
              >
                <input
                  id="addconn-response-path"
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
          {saving ? t("submitting") : t("submit")}
        </button>
      </div>
    </Dialog>
  );
}
