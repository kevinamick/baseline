"use client";

import { useActionState, useState } from "react";
import {
  updateProfile,
  changeEmail,
  changePassword,
} from "@/app/actions/account";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40 disabled:opacity-50";

const sectionCls =
  "flex flex-col gap-5 rounded-2xl border border-hairline-cool bg-white p-6 shadow-card";

const buttonCls =
  "self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
    </div>
  );
}

function ProfileSection({ displayName }: { displayName: string }) {
  const [state, formAction, pending] = useActionState(updateProfile, {});

  return (
    <form action={formAction} className={sectionCls} aria-label="Profile">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Profile</h2>
        <p className="text-[13px] text-zinc-500">
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
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-emerald-600">
          Profile saved.
        </p>
      )}

      <button type="submit" disabled={pending} className={buttonCls}>
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
        <p className="text-[13px] text-zinc-500">
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
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.emailSent && (
        <p role="status" className="text-sm text-emerald-600">
          Check both your current and new inboxes — confirm from each link to
          finish the change.
        </p>
      )}

      <button type="submit" disabled={pending} className={buttonCls}>
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
        <p className="text-[13px] text-zinc-500">
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
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.codeSent && !state.saved && (
        <p role="status" className="text-sm text-emerald-600">
          We emailed a confirmation code to your address. Enter it to finish.
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-sm text-emerald-600">
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
            className={buttonCls}
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
          className={buttonCls}
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
