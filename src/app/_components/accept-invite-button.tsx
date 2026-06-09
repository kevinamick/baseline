"use client";

import { useActionState } from "react";
import { acceptInvitation } from "@/app/actions/invitations";

/**
 * Accepts an invitation by id. Shared by the emailed `/invite/accept` page and
 * the onboarding pending-invite surface — both post the same server action,
 * which grants the membership and redirects to /rubrics on success.
 */
export function AcceptInviteButton({
  invitationId,
  label = "Accept invitation",
  className,
}: {
  invitationId: string;
  label?: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(acceptInvitation, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="invitationId" value={invitationId} />
      <button
        type="submit"
        disabled={pending}
        className={
          className ??
          "w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-soft disabled:opacity-50"
        }
      >
        {pending ? "Accepting…" : label}
      </button>
      {state.error && (
        <p role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}
    </form>
  );
}
