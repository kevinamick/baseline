"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/app/_components/dialog";
import { XIcon } from "@/app/_components/icons";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import { updateConnectionModules } from "@/app/actions/connections";

// List-row shape for the Connections settings surface. requestTemplate is the stored jsonb
// pretty-printed back to a string (the editor and the cross-validation work on strings).
export interface EditableConnection {
  id: string;
  name: string;
  kind: "agent" | "dataset";
  provider: string;
  endpoint: string;
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
  const [editing, setEditing] = useState<EditableConnection | null>(null);

  if (connections.length === 0) {
    return (
      <p className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 text-sm text-fg-3">
        No connections yet. Create one from the Schedules or Optimizations wizard.
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
                {conn.kind === "dataset" ? `Data source (${conn.provider})` : "Live agent"} ·{" "}
                {conn.endpoint}
              </p>
              {conn.kind === "agent" && (
                <p className="mt-1 text-xs text-fg-3">
                  {conn.modules.length > 0 ? (
                    <>
                      Modules:{" "}
                      {conn.modules.map((m) => (
                        <code key={m.name} className="mr-1 font-mono text-[11px] text-ink">
                          {m.name}
                        </code>
                      ))}
                    </>
                  ) : (
                    "No Modules — not optimizable yet"
                  )}
                </p>
              )}
            </div>
            {conn.kind === "agent" && canWrite && (
              <button
                type="button"
                onClick={() => setEditing(conn)}
                className="shrink-0 rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
              >
                Edit Modules
              </button>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <EditModulesDialog
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </>
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
  const [modules, setModules] = useState<ModuleRow[]>(connection.modules);
  const [requestTemplate, setRequestTemplate] = useState(connection.requestTemplate);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    try {
      JSON.parse(requestTemplate);
    } catch {
      setError("Request template must be valid JSON.");
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
      setError("Couldn't save the connection. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onClose={onClose} ariaLabelledBy="edit-modules-title" className="max-w-2xl max-h-[90vh]">
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 id="edit-modules-title" className="text-lg font-semibold tracking-[-0.015em]">
            Edit Modules — {connection.name}
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
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex flex-col gap-5">
          {error && (
            <p role="alert" className="text-sm text-danger-fg">
              {error}
            </p>
          )}
          <p className="text-xs text-fg-3">
            Modules are the named prompts an optimization run tunes. Each one must be
            referenced as <code className="font-mono">{"{{prompt:<name>}}"}</code> in the
            request template — scheduled runs render the seed text in its place.
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

      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-hairline bg-paper-warm px-6 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save Modules"}
        </button>
      </div>
    </Dialog>
  );
}
