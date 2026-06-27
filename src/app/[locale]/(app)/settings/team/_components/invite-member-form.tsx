"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { inviteMember } from "@/app/actions/invitations";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50 disabled:opacity-50";

/**
 * Admin invite form. Posts `inviteMember`; on success the action revalidates the
 * team page so the new pending invite appears in the list rendered by the server
 * component above it.
 *
 * On the Free plan the form is frozen with upgrade language (#344). If the
 * server returns a seat-limit error from any plan, a modal upsell intercepts
 * with a direct link to the pricing page (#349).
 */
export function InviteMemberForm({
  freePlan = false,
}: {
  freePlan?: boolean;
}) {
  const [state, formAction, pending] = useActionState(inviteMember, {});
  const t = useTranslations("Settings.team.invite");
  // The error string the user has dismissed the modal for — prevents the modal
  // from re-popping on re-render while still allowing a NEW seat-limit error to
  // trigger it again.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Detect a seat-limit refusal from the server action — the error mentions
  // "upgrade to invite teammates" (the seat-cap wording from inviteMember).
  const seatLimitError =
    state.error != null && /upgrade to invite teammates/i.test(state.error);

  const showModal = seatLimitError && state.error !== dismissedError;

  return (
    <>
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
              disabled={pending || freePlan}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "invite-email-error" : undefined}
            />
            <button
              type="submit"
              disabled={pending || freePlan}
              className="shrink-0 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
            >
              {pending ? t("sending") : t("submit")}
            </button>
          </div>
        </div>

        {freePlan && (
          <p className="text-sm text-fg-2" data-testid="invite-free-blocked">
            {t.rich("freeBlocked", {
              strong: (chunks) => (
                <Link href="/pricing" className="font-medium text-ink underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
        {state.error && !seatLimitError && (
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

      {showModal && state.error && (
        <SeatLimitUpsell onClose={() => setDismissedError(state.error ?? null)} />
      )}
    </>
  );
}

/**
 * Modal upsell shown when a seat-limit refusal comes back from the server
 * (#349). Links to the pricing page so the user can upgrade directly.
 */
function SeatLimitUpsell({ onClose }: { onClose: () => void }) {
  const tTeam = useTranslations("Settings.team");
  return (
    <ConfirmDialog
      title={tTeam("seatLimitTitle")}
      message={
        <span data-testid="seat-limit-upsell-message">
          {tTeam("seatLimitMessage", {
            plan: "Free",
            count: 1,
          })}
        </span>
      }
      confirmLabel={tTeam("seatLimitConfirm")}
      cancelLabel={tTeam("seatLimitCancel")}
      onConfirm={() => {
        window.location.href = "/pricing";
      }}
      onCancel={onClose}
      destructive={false}
    />
  );
}
