"use client";

import { useActionState, useState } from "react";
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

  return (
    <form action={formAction} className={sectionCls} aria-label="Profile">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Profile</h2>
        <p className="text-[13px] text-fg-3">
          Your display name is shown across Baseline.
        </p>
      </div>

      <Field label="Display name">
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          defaultValue={displayName}
          placeholder="Ada Lovelace"
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
          Profile saved.
        </p>
      )}

      <button type="submit" disabled={pending} className={solidBtnCls}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function EmailSection({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(changeEmail, {});

  return (
    <form action={formAction} className={sectionCls} aria-label="Email">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Email</h2>
        <p className="text-[13px] text-fg-3">
          Signed in as <span className="text-ink">{email}</span>.
        </p>
      </div>

      <Field label="New email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
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
          Check both your current and new inboxes — confirm from each link to
          finish the change.
        </p>
      )}

      <button type="submit" disabled={pending} className={solidBtnCls}>
        {pending ? "Sending…" : "Change email"}
      </button>
    </form>
  );
}

function PasswordSection() {
  const [state, formAction, pending] = useActionState(changePassword, {});
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
    <form action={formAction} className={sectionCls} aria-label="Password">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Password</h2>
        <p className="text-[13px] text-fg-3">
          Choose a new password. We&apos;ll email a code to confirm it&apos;s
          you before it takes effect.
        </p>
      </div>

      <Field label="New password">
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
      <Field label="Confirm new password">
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
        <Field label="Confirmation code">
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
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
          We emailed a confirmation code to your address. Enter it to finish.
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-success">
          Password updated.
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
            {pending ? "Saving…" : "Update password"}
          </button>
          <button
            type="submit"
            name="intent"
            value="send-code"
            disabled={pending}
            className="text-[13px] font-medium text-ink hover:underline disabled:opacity-50"
          >
            Resend code
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
          {pending ? "Sending…" : "Send confirmation code"}
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
