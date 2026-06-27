"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { deleteAccount, exportAccountData } from "@/app/actions/data-rights";
import { inputCls, sectionCls, solidBtnCls } from "@/app/_components/form-styles";

function ExportSection() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("Settings.account.export");

  // Right to portability (#69): the server action returns the JSON; the browser
  // turns it into a file download. Keeping the data off a GET route means it's
  // never prefetched or cached — it's a POST-backed action behind the session.
  async function onExport() {
    setPending(true);
    setError(null);
    try {
      const result = await exportAccountData();
      if (result.error || !result.json) {
        setError(result.error ?? t("genericError"));
        return;
      }
      const url = URL.createObjectURL(
        new Blob([result.json], { type: "application/json" })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename ?? "baseline-data-export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={sectionCls} aria-label={t("ariaLabel")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
        <p className="text-[13px] text-fg-3">{t("blurb")}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onExport}
        disabled={pending}
        className={solidBtnCls}
      >
        {pending ? t("preparing") : t("download")}
      </button>
    </section>
  );
}

function DeleteSection({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(deleteAccount, {});
  const [confirm, setConfirm] = useState("");
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("Settings.account.delete");

  // Strong, deliberate guardrail for an irreversible action: the user must type
  // their exact email to enable the button. The server re-checks the match, so
  // this is UX, not the security boundary. No modal — an inline danger zone
  // keeps the destructive choice explicit and on-page (consistent with the rest
  // of account settings). The action redirects home on success.
  const matches = confirm.trim().toLowerCase() === email.toLowerCase();

  return (
    <section
      aria-label={t("ariaLabel")}
      className="flex flex-col gap-5 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-fg-2">{t("heading")}</h2>
        <p className="text-[13px] text-fg-3">{t("blurb")}</p>
      </div>

      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="self-start rounded-full border border-hairline-field px-4 py-2 text-sm font-medium text-fg-3 transition-colors hover:bg-card-warm"
      >
        {t("heading")}
      </button>

      {expanded && (
        <form
          action={formAction}
          className="flex flex-col gap-5 rounded-xl border border-danger bg-danger-bg p-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">
              {t.rich("confirmLabel", {
                email,
                b: (chunks) => <span className="text-danger-fg">{chunks}</span>,
              })}
            </span>
            <input
              name="confirm"
              type="text"
              autoComplete="off"
              placeholder={email}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputCls}
              disabled={pending}
            />
          </label>

          {state.error && (
            <p role="alert" className="text-sm text-danger-fg">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending || !matches}
            className="self-start rounded-full bg-danger px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-danger-hover disabled:opacity-50"
          >
            {pending ? t("deleting") : t("submit")}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * GDPR data-subject-rights controls on the account page (#69): export (right to
 * portability) and account deletion (right to erasure).
 */
export function AccountDataRights({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-6">
      <ExportSection />
      <DeleteSection email={email} />
    </div>
  );
}
