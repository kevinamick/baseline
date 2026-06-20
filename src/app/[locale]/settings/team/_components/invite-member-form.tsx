"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { inviteMember } from "@/app/actions/invitations";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";

/**
 * Admin invite form. Posts `inviteMember`; on success the action revalidates the
 * team page so the new pending invite appears in the list rendered by the server
 * component above it.
 */
export function InviteMemberForm() {
  const [state, formAction, pending] = useActionState(inviteMember, {});
  const t = useTranslations("Settings.team.invite");

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-email" className="text-[13px] font-medium text-ink">
          {t("label")}
        </label>
        <div className="flex gap-2">
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder={t("placeholder")}
            className={inputCls}
            disabled={pending}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "invite-email-error" : undefined}
          />
          <button
            type="submit"
            disabled={pending}
            className="shrink-0 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
          >
            {pending ? t("sending") : t("submit")}
          </button>
        </div>
      </div>

      {state.error && (
        <p id="invite-email-error" role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}
      {state.sentTo && (
        <p role="status" className="text-sm text-success-fg">
          {t("sentTo", { email: state.sentTo })}
        </p>
      )}
    </form>
  );
}
