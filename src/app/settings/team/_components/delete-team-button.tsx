"use client";

import { useState, useTransition } from "react";
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

  return (
    <div className="flex flex-col gap-3">
      {confirming ? (
        <>
          <p className="text-sm text-ink">
            This permanently deletes <strong>{teamName}</strong> and all of its
            rubrics, connections, and schedules. This can&apos;t be undone.
          </p>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => startDelete(async () => {
                await deleteOrganization();
              })}
              className="rounded-full bg-red-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              {isDeleting ? "Deleting…" : "Delete forever"}
            </button>
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => setConfirming(false)}
              className="rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start rounded-full border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
        >
          Delete this team
        </button>
      )}
    </div>
  );
}
