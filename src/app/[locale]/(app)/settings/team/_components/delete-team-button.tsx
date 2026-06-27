"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { deleteOrganization } from "@/app/actions/orgs";

/**
 * Danger-zone control for deleting the active team. Deleting cascades away every
 * org-scoped row, so it's a confirm-then-act: the first click reveals the
 * consequence and an explicit confirm button rather than firing immediately.
 *
 * The server action redirects on success (into a remaining team, or onboarding),
 * so there's no success state to render here — it just navigates away.
 */
export function DeleteTeamButton({ teamName }: { teamName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const t = useTranslations("Settings.team");

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setConfirming(!confirming)}
        className="self-start rounded-full border border-hairline-field px-4 py-2 text-sm font-medium text-fg-3 transition-colors hover:bg-card-warm"
      >
        {t("deleteTeam")}
      </button>

      {confirming && (
        <div className="flex flex-col gap-3 rounded-xl border border-danger bg-danger-bg p-4">
          <p className="text-sm text-ink">
            {t.rich("deleteConfirm", {
              name: teamName,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          {deleteError && (
            <p className="text-sm text-danger">{deleteError}</p>
          )}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => {
                setDeleteError(null);
                startDelete(async () => {
                  const result = await deleteOrganization();
                  if (result.error) setDeleteError(result.error);
                });
              }}
              className="rounded-full bg-danger px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-hover disabled:opacity-50"
            >
              {isDeleting ? t("deleting") : t("deleteForever")}
            </button>
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => setConfirming(false)}
              className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm disabled:opacity-50"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
