"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { inviteMember } from "@/app/actions/invitations";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";

/**
 * Admin invite form. Posts `inviteMember`; on success the action revalidates the
 * team page so the new pending invite appears in the list rendered by the server
 * component above it.
 *
 * When `atSeatLimit` is true (free plan, already at the 1-seat cap), submitting
 * intercepts the action client-side and shows an upsell modal instead of posting
 * to the server — which would just return the same seat-limit error anyway.
 */
export function InviteMemberForm({ atSeatLimit = false }: { atSeatLimit?: boolean }) {
  const [state, formAction, pending] = useActionState(inviteMember, {});
  const [showUpsell, setShowUpsell] = useState(false);
  const t = useTranslations("Settings.team.invite");

  return (
    <>
      <form
        action={formAction}
        onSubmit={
          atSeatLimit
            ? (e) => {
                e.preventDefault();
                setShowUpsell(true);
              }
            : undefined
        }
        className="flex flex-col gap-3"
      >
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

      {/* Upsell modal: shown when a free-plan admin tries to invite past the 1-seat cap */}
      {showUpsell && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="upsell-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowUpsell(false);
          }}
        >
          <div className="mx-4 w-full max-w-sm rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
            <h2 id="upsell-title" className="text-base font-semibold text-ink">
              {t("upsellTitle")}
            </h2>
            <p className="mt-2 text-sm text-fg-2">{t("upsellBody")}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowUpsell(false)}
                className="rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
              >
                {t("upsellCancel")}
              </button>
              <Link
                href="/pricing"
                className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-fg-on-ink transition-colors hover:bg-ink-hover"
              >
                {t("upsellCta")} →
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
