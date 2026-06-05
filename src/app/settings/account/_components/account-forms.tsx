"use client";

import { useActionState } from "react";
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

  return (
    <form action={formAction} className={sectionCls} aria-label="Password">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">Password</h2>
        <p className="text-[13px] text-zinc-500">
          Choose a new password for signing in.
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
          Password updated.
        </p>
      )}

      <button type="submit" disabled={pending} className={buttonCls}>
        {pending ? "Saving…" : "Update password"}
      </button>
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
