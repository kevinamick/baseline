"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn, signUp } from "@/app/actions/auth";
import { track } from "@/lib/analytics/client";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";

const cardCls =
  "form-reveal flex w-full max-w-md flex-col gap-5 rounded-2xl border border-hairline-cool bg-white p-8 shadow-card";

function AuthFields({
  pending,
  passwordAutoComplete,
}: {
  pending: boolean;
  passwordAutoComplete: "current-password" | "new-password";
}) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-[13px] font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="you@company.com"
          className={inputCls}
          disabled={pending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-[13px] font-medium text-ink">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
          minLength={6}
          className={inputCls}
          disabled={pending}
        />
      </div>
    </>
  );
}

export function SignInForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(signIn, {});

  return (
    <form action={formAction} className={cardCls}>
      {next && <input type="hidden" name="next" value={next} />}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Sign in to Baseline
        </h1>
        <p className="text-[13px] text-zinc-500">Welcome back.</p>
      </div>

      <AuthFields pending={pending} passwordAutoComplete="current-password" />

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        onClick={() => track({ name: "auth.sign_in_clicked" })}
        className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-center text-[13px] text-zinc-500">
        No account?{" "}
        <Link href="/sign-up" className="font-medium text-ink hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUp, {});

  if (state.emailSent) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Check your email
        </h1>
        <p className="text-sm leading-normal text-zinc-600">
          We sent a confirmation link to your inbox. Click it to finish setting
          up your account and sign in.
        </p>
        <p className="text-[13px] text-zinc-500">
          Already confirmed?{" "}
          <Link href="/sign-in" className="font-medium text-ink hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className={cardCls}>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Create your account
        </h1>
        <p className="text-[13px] text-zinc-500">
          Start measuring agent quality.
        </p>
      </div>

      <AuthFields pending={pending} passwordAutoComplete="new-password" />

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        onClick={() => track({ name: "auth.signup_started" })}
        className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create account"}
      </button>

      <p className="text-center text-[13px] text-zinc-500">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
