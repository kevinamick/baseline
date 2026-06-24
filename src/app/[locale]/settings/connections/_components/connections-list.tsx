"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dialog } from "@/app/_components/dialog";
import { TrashIcon, XIcon } from "@/app/_components/icons";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import { ManagedAgentFields } from "@/app/_components/managed-agent-fields";
import { DEFAULT_TARGET_MODEL, type TargetModelId } from "@/lib/optimization/models";
import {
  updateConnectionModules,
  updateManagedConnection,
  deleteConnection,
  getConnectionDeletionImpact,
  type ConnectionDeletionImpact,
} from "@/app/actions/connections";

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
}

// The minimal connection edit surface (#119): a read-only list of the team's Connections,
// with an "Edit Modules" dialog on agent rows. Editing reuses the shared ModulesEditor —
// the same rows + template + declared↔referenced cross-validation as both create wizards.
export function ConnectionsList({ connections, canWrite }: Props) {
  const router = useRouter();
  const t = useTranslations("Settings.connections");
  const [editing, setEditing] = useState<EditableConnection | null>(null);
  const [deleting, setDeleting] = useState<EditableConnection | null>(null);

  if (connections.length === 0) {
    return (
      <p className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 text-sm text-fg-3">
        {t("empty")}
      </p>
    );
  }

  return (
    <>
      <ul className="mt-6 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card">
        {connections.map((conn) => (
          <li key={conn.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{conn.name}</p>
              <p className="mt-0.5 truncate text-xs text-fg-3">
                {conn.kind === "dataset"
                  ? t("dataSource", { provider: conn.provider })
                  : conn.agentKind === "managed"
                    ? t("managedAgent")
                    : t("liveAgent")}
                {/* A managed agent has no endpoint (it runs on the managed LLM). */}
                {conn.agentKind !== "managed" && conn.endpoint ? ` · ${conn.endpoint}` : null}
              </p>
              {conn.kind === "agent" && conn.agentKind !== "managed" && (
                <p className="mt-1 text-xs text-fg-3">
                  {conn.modules.length > 0 ? (
                    <>
                      {t("modulesLabel")}
                      {conn.modules.map((m) => (
                        <code key={m.name} className="mr-1 font-mono text-[11px] text-ink">
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
                    {conn.agentKind === "managed" ? t("editPrompt") : t("editModules")}
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
    </>
  );
}

// Counts → a human phrase for the confirm body, e.g. "2 schedules and 1 past optimization run".
// Only reached when the delete is unblocked, so every counted run is terminal ("past").
function describeDependents(
  impact: ConnectionDeletionImpact,
  t: ReturnType<typeof useTranslations<"Settings.connections">>,
): string {
  const schedules = impact.schedules > 0 ? t("dependentSchedules", { count: impact.schedules }) : null;
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
        if ("error" in result) setError(result.error);
        else setImpact(result);
        setLoading(false);
      })
      .catch(() => {
        if (active) { setError(t("checkFailed")); setLoading(false); }
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
          <h3 className="text-lg font-semibold tracking-[-0.015em]">{t("deleteTitle")}</h3>
        </div>
        <div className="flex flex-col gap-1.5 px-6 py-5">
          {loading ? (
            <p className="text-sm text-fg-3">{t("deleteChecking")}</p>
          ) : blocked ? (
            <p className="text-sm leading-normal text-ink">{impact?.blockReason}</p>
          ) : (
            <>
              <p className="text-sm leading-normal text-ink">
                {t.rich("deleteBody", {
                  name: connection.name,
                  strong: (chunks) => <span className="font-semibold">{chunks}</span>,
                })}
              </p>
              {impact && (impact.schedules > 0 || impact.optimizationRuns > 0) && (
                <p className="text-[13px] text-fg-3">
                  {t("deleteDependents", { dependents: describeDependents(impact, t) })}
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
              {deleting ? t("deleting") : confirming ? t("deleteConfirm") : t("delete")}
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
  const [requestTemplate, setRequestTemplate] = useState(connection.requestTemplate);
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
    const mErr = modulesEditorError(modules, requestTemplate, { requireModules: false });
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
    <Dialog onClose={onClose} ariaLabelledBy="edit-modules-title" className="max-w-2xl max-h-[90dvh]">
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
    connection.targetModel ?? DEFAULT_TARGET_MODEL
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
    <Dialog onClose={onClose} ariaLabelledBy="edit-prompt-title" className="max-w-2xl max-h-[90dvh]">
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
