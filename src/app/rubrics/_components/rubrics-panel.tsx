"use client";

import { useState, useTransition } from "react";
import { RubricDialog } from "./rubric-dialog";
import { deleteRubric } from "@/app/actions/rubrics";
import { track } from "@/lib/analytics/client";
import { PencilIcon, PlusIcon, TrashIcon } from "@/app/_components/icons";
import type { RubricSummary } from "@/types/rubric";

const MODE_LABEL: Record<string, string> = {
  prompt_response: "Prompt / Response",
  conversational: "Conversational",
};

type DialogState =
  | null
  | { type: "create" }
  | { type: "edit"; rubricId: string };

interface Props {
  rubrics: RubricSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function RubricsPanel({ rubrics, selectedId, onSelect }: Props) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, startDelete] = useTransition();

  const rubricToDelete = rubrics.find((r) => r.id === deleteId);

  function closeDelete() {
    setDeleteId(null);
    setConfirmingDelete(false);
  }

  function confirmDelete() {
    if (!deleteId) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    startDelete(async () => {
      await deleteRubric(deleteId);
      closeDelete();
    });
  }

  return (
    <>
      <div className="flex w-[30%] shrink-0 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-white shadow-card">
        <div className="flex min-h-[60px] shrink-0 items-center justify-between border-b border-hairline px-5 py-4">
          <h2 className="text-base font-semibold tracking-[-0.01em]">Rubrics</h2>
          <button
            onClick={() => {
              track({ name: "rubric.create_dialog_opened" });
              setDialog({ type: "create" });
            }}
            className="inline-flex items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-ink-soft"
          >
            <PlusIcon size={12} /> New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {rubrics.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5 px-4 text-center">
              <p className="text-sm text-zinc-400">No rubrics yet</p>
              <button
                onClick={() => {
                  track({ name: "rubric.create_dialog_opened" });
                  setDialog({ type: "create" });
                }}
                className="text-sm font-medium text-zinc-600 transition-colors hover:text-ink"
              >
                Create your first rubric →
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rubrics.map((rubric) => {
                const selected = rubric.id === selectedId;
                return (
                  <li key={rubric.id} className="list-none">
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className={`group/row flex items-stretch overflow-hidden rounded-lg border transition-colors ${
                        selected
                          ? "border-accent bg-accent-soft"
                          : "border-transparent bg-card-warm hover:bg-paper-warm"
                      }`}
                    >
                      {/* Content — click to select */}
                      <button
                        type="button"
                        onClick={() => onSelect(rubric.id)}
                        aria-pressed={selected}
                        className="flex min-w-0 flex-1 flex-col gap-1 rounded-l-lg px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40"
                      >
                        <p
                          className={`truncate text-sm text-ink ${
                            selected ? "font-semibold" : "font-medium"
                          }`}
                        >
                          {rubric.name}
                        </p>
                        <div
                          className={`flex items-center gap-1.5 text-xs ${
                            selected ? "text-accent-ink" : "text-zinc-500"
                          }`}
                        >
                          <span>
                            {MODE_LABEL[rubric.evaluation_mode] ??
                              rubric.evaluation_mode}
                          </span>
                          <span className="text-zinc-400">·</span>
                          <span>
                            Created{" "}
                            {new Date(rubric.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </button>
                      {/* Pencil — edit */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          track({ name: "rubric.edit_dialog_opened" });
                          setDialog({ type: "edit", rubricId: rubric.id });
                        }}
                        aria-label="Edit rubric"
                        className={`flex shrink-0 items-center px-3 text-zinc-500 transition-[opacity,color] hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40 ${
                          selected
                            ? "opacity-100"
                            : "opacity-0 group-hover/row:opacity-100"
                        }`}
                      >
                        <PencilIcon size={15} />
                      </button>
                      {/* Trash — delete */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(false);
                          setDeleteId(rubric.id);
                        }}
                        aria-label="Delete rubric"
                        className={`flex shrink-0 items-center rounded-r-lg px-3 text-zinc-500 transition-[opacity,color] hover:text-red-500 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40 ${
                          selected
                            ? "opacity-100"
                            : "opacity-0 group-hover/row:opacity-100"
                        }`}
                      >
                        <TrashIcon size={15} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {dialog?.type === "create" && (
        <RubricDialog mode="create" onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "edit" && (
        <RubricDialog
          key={dialog.rubricId}
          mode="edit"
          rubricId={dialog.rubricId}
          onClose={() => setDialog(null)}
        />
      )}

      {/* Delete confirmation dialog — two-press escalation. No Esc-to-close,
          preserving the destructive-action guardrail. */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-ink/45" onClick={closeDelete} />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-hairline-cool bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
              <h3 className="text-lg font-semibold tracking-[-0.015em]">
                Delete rubric
              </h3>
            </div>
            <div className="flex flex-col gap-1.5 px-6 py-5">
              <p className="text-sm leading-normal text-ink">
                <span className="font-semibold">
                  &ldquo;{rubricToDelete?.name}&rdquo;
                </span>{" "}
                will be permanently deleted.
              </p>
              <p className="text-[13px] text-zinc-500">
                This action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2.5 border-t border-hairline bg-paper-warm px-6 py-3.5">
              <button
                onClick={closeDelete}
                className="rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="rounded-full bg-red-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {isDeleting
                  ? "Deleting…"
                  : confirmingDelete
                    ? "Delete forever?"
                    : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
