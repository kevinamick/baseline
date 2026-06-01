"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createEmailGroup,
  updateEmailGroup,
  deleteEmailGroup,
} from "@/app/actions/email-groups";
import { EmailTagsField, useEmailTags } from "@/app/_components/email-tags-field";
import { PlusIcon, TrashIcon } from "@/app/_components/icons";
import type { EmailGroup } from "@/types/email-group";

interface Props {
  groups: EmailGroup[];
}

function GroupForm({
  initialName,
  initialEmails,
  onSave,
  onCancel,
  saving,
  error,
  inputIdSuffix,
}: {
  initialName: string;
  initialEmails: string[];
  onSave: (name: string, emails: string[]) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  inputIdSuffix: string;
}) {
  const [name, setName] = useState(initialName);
  const tags = useEmailTags(initialEmails);

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-accent bg-card-warm p-5">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`eg-name-${inputIdSuffix}`} className="text-xs font-medium text-zinc-600">
          Group name
        </label>
        <input
          id={`eg-name-${inputIdSuffix}`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Engineering team"
          className={inputCls}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`eg-emails-${inputIdSuffix}`} className="text-xs font-medium text-zinc-600">
          Email addresses
        </label>
        <EmailTagsField id={`eg-emails-${inputIdSuffix}`} tags={tags} />
        <p className="text-xs text-zinc-400">Press Enter or comma to add each address.</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(name, tags.resolve())}
          disabled={saving}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function EmailGroupsClient({ groups }: Props) {
  const router = useRouter();
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleCreate(name: string, emails: string[]) {
    setSaving(true);
    setFormError(null);
    try {
      const result = await createEmailGroup(name, emails);
      if ("error" in result) {
        setFormError(result.error);
        return;
      }
      setShowNew(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(id: string, name: string, emails: string[]) {
    setSaving(true);
    setFormError(null);
    try {
      const result = await updateEmailGroup(id, name, emails);
      if (result && "error" in result) {
        setFormError(result.error);
        return;
      }
      setEditingId(null);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this email group?")) return;
    const result = await deleteEmailGroup(id);
    if (result && "error" in result) {
      alert(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.length === 0 && !showNew && (
        <p className="text-sm text-zinc-500">No email groups yet.</p>
      )}

      {groups.map((group) =>
        editingId === group.id ? (
          <GroupForm
            key={group.id}
            initialName={group.name}
            initialEmails={group.emails}
            onSave={(name, emails) => handleUpdate(group.id, name, emails)}
            onCancel={() => { setEditingId(null); setFormError(null); }}
            saving={saving}
            error={formError}
            inputIdSuffix={group.id}
          />
        ) : (
          <div
            key={group.id}
            className="flex items-start justify-between gap-4 rounded-xl border border-hairline bg-white p-4"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold text-ink">{group.name}</span>
              <span className="text-xs text-zinc-500 break-all">
                {group.emails.join(", ") || "No addresses"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => { setEditingId(group.id); setFormError(null); }}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-card-warm hover:text-ink"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => handleDelete(group.id)}
                aria-label={`Delete ${group.name}`}
                className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </div>
        )
      )}

      {showNew ? (
        <GroupForm
          initialName=""
          initialEmails={[]}
          onSave={handleCreate}
          onCancel={() => { setShowNew(false); setFormError(null); }}
          saving={saving}
          error={formError}
          inputIdSuffix="new"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 self-start rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
        >
          <PlusIcon size={13} /> New group
        </button>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";
