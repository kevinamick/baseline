"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createOrganization } from "@/app/actions/orgs";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";

export function CreateTeamForm() {
  const t = useTranslations("EntryFlows");
  const [state, formAction, pending] = useActionState(createOrganization, {});

  return (
    <form
      action={formAction}
      className="form-reveal flex w-full max-w-md flex-col gap-5 rounded-2xl border border-hairline-cool bg-card p-8 shadow-card"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="team-name" className="text-[13px] font-medium text-ink">
          {t("teamNameLabel")}
        </label>
        <input
          id="team-name"
          name="name"
          type="text"
          autoFocus
          required
          maxLength={80}
          placeholder={t("teamNamePlaceholder")}
          className={inputCls}
          disabled={pending}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "team-name-error" : undefined}
        />
        {state.error && (
          <p id="team-name-error" role="alert" className="text-sm text-danger-fg">
            {state.error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
      >
        {pending ? t("createTeamPending") : t("createTeam")}
      </button>
    </form>
  );
}
