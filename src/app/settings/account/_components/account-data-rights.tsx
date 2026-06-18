"use client";

import { useActionState, useState } from "react";
import { deleteAccount, exportAccountData } from "@/app/actions/data-rights";
import { inputCls, sectionCls, solidBtnCls } from "@/app/_components/form-styles";

function ExportSection() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Right to portability (#69): the server action returns the JSON; the browser
  // turns it into a file download. Keeping the data off a GET route means it's
  // never prefetched or cached — it's a POST-backed action behind the session.
  async function onExport() {
    setPending(true);
    setError(null);
    const result = await exportAccountData();
    setPending(false);
    if (result.error || !result.json) {
      setError(result.error ?? "Could not export your data.");
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
  }

  return (
    <section className={sectionCls} aria-label="Export your data">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Export your data</h2>
        <p className="text-[13px] text-fg-3">
          Download a copy of your personal data — your profile, team
          memberships, and the rubrics you&apos;ve created — as a JSON file.
        </p>
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
        {pending ? "Preparing…" : "Download my data"}
      </button>
    </section>
  );
}

function DeleteSection({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(deleteAccount, {});
  const [confirm, setConfirm] = useState("");

  // Strong, deliberate guardrail for an irreversible action: the user must type
  // their exact email to enable the button. The server re-checks the match, so
  // this is UX, not the security boundary. No modal — an inline danger zone
  // keeps the destructive choice explicit and on-page (consistent with the rest
  // of account settings). The action redirects home on success.
  const matches = confirm.trim().toLowerCase() === email.toLowerCase();

  return (
    <form
      action={formAction}
      aria-label="Delete account"
      className="flex flex-col gap-5 rounded-2xl border border-danger bg-card p-6 shadow-card"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-danger-fg">Delete account</h2>
        <p className="text-[13px] text-fg-3">
          Permanently delete your account and all data you own — your profile,
          rubrics, and any teams where you&apos;re the only member. This
          can&apos;t be undone.
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-ink">
          Type <span className="text-danger-fg">{email}</span> to confirm
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
        {pending ? "Deleting…" : "Delete my account"}
      </button>
    </form>
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
