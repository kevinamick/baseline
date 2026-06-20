"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RubricDialog } from "./rubric-dialog";
import { deleteRubric } from "@/app/actions/rubrics";
import { track } from "@/lib/analytics/client";
import { PencilIcon, PlusIcon, SearchIcon, TrashIcon, XIcon } from "@/app/_components/icons";
import { ClientDate } from "@/app/_components/client-date";
import type { RubricSummary } from "@/types/rubric";

type SortOrder = "newest" | "oldest" | "name";

type DialogState =
  | null
  | { type: "create" }
  | { type: "edit"; rubricId: string };

interface Props {
  rubrics: RubricSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canWrite: boolean;
}

export function RubricsPanel({ rubrics, selectedId, onSelect, canWrite }: Props) {
  const t = useTranslations("Rubrics");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  const rubricToDelete = rubrics.find((r) => r.id === deleteId);

  const filteredRubrics = rubrics
    .filter(
      (r) =>
        searchQuery === "" ||
        r.name.toLowerCase().includes(searchQuery.toLowerCase()),
    )
    .sort((a, b) => {
      if (sortOrder === "oldest")
        return (
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      if (sortOrder === "name") return a.name.localeCompare(b.name);
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });

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
      <div className="flex w-[30%] shrink-0 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card shadow-card">
        <div className="flex min-h-[60px] shrink-0 items-center justify-between border-b border-hairline px-5 py-4">
          <h2 className="text-base font-semibold tracking-[-0.01em]">{t("list.panelTitle")}</h2>
          {canWrite && (
            <button
              onClick={() => {
                track({ name: "rubric.create_dialog_opened" });
                setDialog({ type: "create" });
              }}
              className="inline-flex items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
            >
              <PlusIcon size={12} /> {t("list.newRubric")}
            </button>
          )}
        </div>

        {rubrics.length > 0 && (
          <div className="shrink-0 border-b border-hairline px-3 py-2">
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <SearchIcon
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3"
                />
                <input
                  type="text"
                  placeholder={t("list.filterPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label={t("list.filterAria")}
                  className="w-full rounded-lg border border-hairline bg-paper-warm py-1.5 pl-9 pr-9 text-sm placeholder:text-fg-3 focus:outline-none focus:ring-2 focus:ring-ink/20"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    aria-label={t("list.clearFilter")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-3 transition-colors hover:text-ink"
                  >
                    <XIcon size={14} />
                  </button>
                )}
              </div>
              <select
                value={sortOrder}
                onChange={(e) =>
                  setSortOrder(e.target.value as SortOrder)
                }
                aria-label={t("list.sortAria")}
                className="rounded-lg border border-hairline bg-paper-warm px-2 py-1.5 text-xs text-fg-2 focus:outline-none focus:ring-2 focus:ring-ink/20"
              >
                <option value="newest">{t("list.sortNewest")}</option>
                <option value="oldest">{t("list.sortOldest")}</option>
                <option value="name">{t("list.sortName")}</option>
              </select>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-1.5">
          {rubrics.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5 px-4 text-center">
              <p className="text-sm text-fg-3">{t("list.emptyTitle")}</p>
              {canWrite && (
                <button
                  onClick={() => {
                    track({ name: "rubric.create_dialog_opened" });
                    setDialog({ type: "create" });
                  }}
                  className="text-sm font-medium text-fg-2 transition-colors hover:text-ink"
                >
                  {t("list.createFirst")}
                </button>
              )}
            </div>
          ) : filteredRubrics.length === 0 ? (
            <div className="flex h-20 items-center justify-center px-4">
              <p className="text-sm text-fg-3">{t("list.noMatch")}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {filteredRubrics.map((rubric) => {
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
                            selected ? "text-accent-ink" : "text-fg-2"
                          }`}
                        >
                          <span>
                            {rubric.evaluation_mode === "prompt_response" ||
                            rubric.evaluation_mode === "conversational"
                              ? t(`mode.${rubric.evaluation_mode}`)
                              : rubric.evaluation_mode}
                          </span>
                          <span className="text-fg-3">·</span>
                          <span>
                            {t("list.createdOn")}{" "}
                            <ClientDate value={rubric.created_at} dateOnly />
                          </span>
                        </div>
                      </button>
                      {/* Pencil — edit (Contributors only) */}
                      {canWrite && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            track({ name: "rubric.edit_dialog_opened" });
                            setDialog({ type: "edit", rubricId: rubric.id });
                          }}
                          aria-label={t("list.editRubric")}
                          className={`flex shrink-0 items-center px-3 text-fg-3 transition-[opacity,color] hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40 ${
                            selected
                              ? "opacity-100"
                              : "opacity-0 group-hover/row:opacity-100"
                          }`}
                        >
                          <PencilIcon size={15} />
                        </button>
                      )}
                      {/* Trash — delete (Contributors only) */}
                      {canWrite && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingDelete(false);
                            setDeleteId(rubric.id);
                          }}
                          aria-label={t("list.deleteRubric")}
                          className={`flex shrink-0 items-center rounded-r-lg px-3 text-fg-3 transition-[opacity,color] hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40 ${
                            selected
                              ? "opacity-100"
                              : "opacity-0 group-hover/row:opacity-100"
                          }`}
                        >
                          <TrashIcon size={15} />
                        </button>
                      )}
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
          <div className="absolute inset-0 bg-overlay" onClick={closeDelete} />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-hairline-cool bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
              <h3 className="text-lg font-semibold tracking-[-0.015em]">
                {t("list.deleteTitle")}
              </h3>
            </div>
            <div className="flex flex-col gap-1.5 px-6 py-5">
              <p className="text-sm leading-normal text-ink">
                {t.rich("list.deleteBody", {
                  name: rubricToDelete?.name ?? "",
                  strong: (chunks) => (
                    <span className="font-semibold">{chunks}</span>
                  ),
                })}
              </p>
              <p className="text-[13px] text-fg-3">
                {t("list.deleteIrreversible")}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2.5 border-t border-hairline bg-paper-warm px-6 py-3.5">
              <button
                onClick={closeDelete}
                className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
              >
                {t("list.cancel")}
              </button>
              <button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="rounded-full bg-danger px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-hover disabled:opacity-50"
              >
                {isDeleting
                  ? t("list.deleting")
                  : confirmingDelete
                    ? t("list.confirmDelete")
                    : t("list.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
