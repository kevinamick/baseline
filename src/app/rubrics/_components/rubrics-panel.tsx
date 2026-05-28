"use client";

import { useEffect, useState, useTransition } from "react";
import { RubricDialog } from "./rubric-dialog";
import { deleteRubric } from "@/app/actions/rubrics";
import { track } from "@/lib/analytics/client";
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
  const [isDeleting, startDelete] = useTransition();

  const rubricToDelete = rubrics.find((r) => r.id === deleteId);

  function confirmDelete() {
    if (!deleteId) return;
    startDelete(async () => {
      await deleteRubric(deleteId);
    });
  }

  return (
    <>
      <div className="w-[30%] flex flex-col overflow-hidden shrink-0 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <div className="flex items-center justify-end px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <button
            onClick={() => {
              track({ name: "rubric.create_dialog_opened" });
              setDialog({ type: "create" });
            }}
            className="text-xs px-3 py-1.5 rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
          >
            + New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {rubrics.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <p className="text-sm text-zinc-400 mb-3">No rubrics yet</p>
              <button
                onClick={() => {
                  track({ name: "rubric.create_dialog_opened" });
                  setDialog({ type: "create" });
                }}
                className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                Create your first rubric →
              </button>
            </div>
          ) : (
            <ul className="p-2 flex flex-col gap-1.5">
              {rubrics.map((rubric) => (
                <li key={rubric.id} className="list-none">
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={`flex items-stretch rounded-lg transition-all group/row border-l-[3px] ${
                      rubric.id === selectedId
                        ? "border-l-zinc-600 dark:border-l-zinc-300 bg-zinc-200 dark:bg-zinc-700/80 ring-1 ring-zinc-300 dark:ring-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_0_rgba(0,0,0,0.06)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-1px_0_rgba(0,0,0,0.2)]"
                        : "border-l-transparent bg-zinc-100 dark:bg-zinc-800/60 hover:bg-zinc-200/70 dark:hover:bg-zinc-700/60"
                    }`}
                  >
                    {/* Content — click to select */}
                    <button
                      type="button"
                      onClick={() => onSelect(rubric.id)}
                      aria-pressed={rubric.id === selectedId}
                      className="flex-1 min-w-0 px-4 py-3 flex flex-col gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-500 rounded-l-md"
                    >
                      <p
                        className={`text-sm truncate transition-all ${
                          rubric.id === selectedId
                            ? "font-semibold"
                            : "font-medium"
                        }`}
                      >
                        {rubric.name}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
                        <span>
                          {MODE_LABEL[rubric.evaluation_mode] ??
                            rubric.evaluation_mode}
                        </span>
                        <span>·</span>
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
                      className={`flex items-center px-2.5 border-l border-zinc-200/60 dark:border-zinc-700/60 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 shrink-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-500 ${
                        rubric.id === selectedId
                          ? "opacity-100"
                          : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                      }`}
                    >
                      <PencilIcon />
                    </button>
                    {/* Trash — delete */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteId(rubric.id);
                      }}
                      aria-label="Delete rubric"
                      className={`flex items-center px-2.5 border-l border-zinc-200/60 dark:border-zinc-700/60 text-zinc-400 hover:text-red-500 rounded-r-md shrink-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-500 ${
                        rubric.id === selectedId
                          ? "opacity-100"
                          : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                      }`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              ))}
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

      {/* Delete confirmation dialog */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDeleteId(null)}
          />
          <div className="relative z-10 w-full max-w-sm mx-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-6">
            <h3 className="text-base font-semibold mb-1">Delete rubric</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                &ldquo;{rubricToDelete?.name}&rdquo;
              </span>{" "}
              will be permanently deleted.
            </p>
            <p className="text-sm text-zinc-400 mb-6">
              This action cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="px-5 py-2 text-sm font-medium rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}
