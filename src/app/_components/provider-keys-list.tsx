"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/app/_components/dialog";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { XIcon } from "@/app/_components/icons";
import { saveProviderKey, deleteProviderKey } from "@/app/actions/provider-keys";
// Type-only import (erased at build), so the server-only keys module never
// reaches the client bundle.
import type { ProviderKeyRow } from "@/lib/llm/keys";

interface Props {
  rows: ProviderKeyRow[];
  canWrite: boolean;
}

export function ProviderKeysList({ rows, canWrite }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<ProviderKeyRow | null>(null);
  const [removing, setRemoving] = useState<ProviderKeyRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove(row: ProviderKeyRow) {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteProviderKey({ provider: row.provider });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setRemoving(null);
      router.refresh();
    } catch {
      setError("Couldn't remove the key. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ul className="mt-6 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card">
        {rows.map((row) => (
          <li key={row.provider} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-ink">{row.label}</p>
                {!row.runtimeReady && (
                  <span className="rounded-full border border-hairline-cool bg-card-warm px-2 py-0.5 text-[11px] font-medium text-fg-3">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-fg-3">
                {row.hasKey ? (
                  <>
                    Key set — <code className="font-mono text-ink">••••&nbsp;{row.last4}</code>
                  </>
                ) : (
                  "No key set"
                )}
              </p>
            </div>

            {canWrite && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(row)}
                  className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
                >
                  {row.hasKey ? "Replace" : "Add key"}
                </button>
                {row.hasKey && (
                  <button
                    type="button"
                    onClick={() => setRemoving(row)}
                    className="rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-danger-fg transition-colors hover:bg-card-warm"
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <SetKeyDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.label} key?`}
          message={
            <>
              Runs that rely on this key will fail until a new one is added. The stored key is
              permanently deleted.
              {error && <span className="mt-2 block text-danger-fg">{error}</span>}
            </>
          }
          confirmLabel="Remove key"
          busy={busy}
          busyLabel="Removing…"
          onConfirm={() => handleRemove(removing)}
          onCancel={() => {
            setRemoving(null);
            setError(null);
          }}
        />
      )}
    </>
  );
}

function SetKeyDialog({
  row,
  onClose,
  onSaved,
}: {
  row: ProviderKeyRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmed = key.trim();
    if (!trimmed) {
      setError("Enter a provider key.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await saveProviderKey({ provider: row.provider, key: trimmed });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onSaved();
    } catch {
      setError("Couldn't save the key. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onClose={onClose} ariaLabelledBy="set-key-title" className="max-w-md">
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 id="set-key-title" className="text-lg font-semibold tracking-[-0.015em]">
            {row.hasKey ? "Replace" : "Add"} {row.label} key
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

      <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="contents">
        <div className="px-6 py-6">
          <label htmlFor="provider-key-input" className="block text-sm font-medium text-ink">
            API key
          </label>
          <input
            id="provider-key-input"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={`Paste your ${row.label} API key`}
            className="mt-2 w-full rounded-xl border border-hairline-cool bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
          <p className="mt-2 text-xs text-fg-3">
            Stored encrypted in your team&apos;s vault. It&apos;s never shown again or sent back to
            the browser after you save.
          </p>
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
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save key"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
