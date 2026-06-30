"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { deleteOrganization } from "@/app/actions/orgs";
import { DangerZone } from "@/app/_components/danger-zone";

/**
 * Danger-zone control for deleting the active team. Deleting cascades away every
 * org-scoped row, so it's a two-stage flow: the first click expands an
 * accordion (neutral styling), and only then is the consequence text and the
 * high-contrast "Delete forever" button revealed.
 *
 * The server action redirects on success (into a remaining team, or onboarding),
 * so there's no success state to render here — it just navigates away.
 */
export function DeleteTeamButton({ teamName }: { teamName: string }) {
  const [isDeleting, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const t = useTranslations("Settings.team");

  return (
    <DangerZone triggerLabel={t("deleteTeam")}>
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
      </div>
    </DangerZone>
  );
}
