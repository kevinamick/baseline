"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import {
  updateProfile,
  changeEmail,
  changePassword,
} from "@/app/actions/account";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { inputCls, sectionCls, solidBtnCls } from "@/app/_components/form-styles";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  // A wrapping <label> associates the text with the single input it contains, so
  // the inputs get an accessible name even when they carry no placeholder (the
  // password/confirm/code fields). A bare <span> left them unnamed.
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}

function ProfileSection({ displayName }: { displayName: string }) {
  const [state, formAction, pending] = useActionState(updateProfile, {});
  const t = useTranslations("Settings.account.profile");

  return (
    <form action={formAction} className={sectionCls} aria-label={t("heading")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
        <p className="text-[13px] text-fg-3">{t("blurb")}</p>
      </div>

      <Field label={t("displayNameLabel")}>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          defaultValue={displayName}
          placeholder={t("displayNamePlaceholder")}
          className={inputCls}
          disabled={pending}
        />
      </Field>

      {state.error && (
        <p role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-success">
          {t("saved")}
        </p>
      )}

      <button type="submit" disabled={pending} className={solidBtnCls}>
        {pending ? t("saving") : t("save")}
      </button>
    </form>
  );
}

function EmailSection({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(changeEmail, {});
  const t = useTranslations("Settings.account.email");

  return (
    <form action={formAction} className={sectionCls} aria-label={t("heading")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
        <p className="text-[13px] text-fg-3">
          {t.rich("signedInAs", {
            email,
            b: (chunks) => <span className="text-ink">{chunks}</span>,
          })}
        </p>
      </div>

      <Field label={t("newEmailLabel")}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder={t("newEmailPlaceholder")}
          className={inputCls}
          disabled={pending}
        />
      </Field>

      {state.error && (
        <p role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}
      {state.emailSent && (
        <p role="status" className="text-sm text-success">
          {t("sent")}
        </p>
      )}

      <button type="submit" disabled={pending} className={solidBtnCls}>
        {pending ? t("sending") : t("submit")}
      </button>
    </form>
  );
}

function PasswordSection() {
  const [state, formAction, pending] = useActionState(changePassword, {});
  const t = useTranslations("Settings.account.password");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");

  // Two-step, email-confirmed change (#74): the first submit (`send-code`) emails
  // a one-time code; once `codeSent`, the code field appears and the primary
  // submit (`submit`) lands the new password. A clicked submit button's
  // name/value rides along in the FormData, so `intent` tells the action which
  // step ran. The inputs are *controlled* because React 19 resets a form after a
  // function action runs — uncontrolled values would be wiped between the two
  // steps, but controlled state survives the reset (and still posts via `name`).
  return (
    <form action={formAction} className={sectionCls} aria-label={t("heading")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
        <p className="text-[13px] text-fg-3">{t("blurb")}</p>
      </div>

      <Field label={t("newPasswordLabel")}>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
          disabled={pending}
        />
      </Field>
      <Field label={t("confirmLabel")}>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={inputCls}
          disabled={pending}
        />
      </Field>

      {state.codeSent && (
        <Field label={t("codeLabel")}>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t("codePlaceholder")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={inputCls}
            disabled={pending}
          />
        </Field>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}
      {state.codeSent && !state.saved && (
        <p role="status" className="text-sm text-success">
          {t("codeSent")}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-success">
          {t("saved")}
        </p>
      )}

      {state.codeSent ? (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            name="intent"
            value="submit"
            disabled={pending}
            className={solidBtnCls}
          >
            {pending ? t("saving") : t("update")}
          </button>
          <button
            type="submit"
            name="intent"
            value="send-code"
            disabled={pending}
            className="text-[13px] font-medium text-ink hover:underline disabled:opacity-50"
          >
            {t("resend")}
          </button>
        </div>
      ) : (
        <button
          type="submit"
          name="intent"
          value="send-code"
          disabled={pending}
          className={solidBtnCls}
        >
          {pending ? t("sending") : t("sendCode")}
        </button>
      )}
    </form>
  );
}

export function AccountForms({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <ProfileSection displayName={displayName} />
      <EmailSection email={email} />
      <PasswordSection />
    </div>
  );
}
