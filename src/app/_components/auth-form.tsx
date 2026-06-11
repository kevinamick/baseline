"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  signIn,
  signUp,
  signInWithOAuth,
  requestPasswordReset,
  resetPassword,
} from "@/app/actions/auth";
import { track } from "@/lib/analytics/client";
import {
  OAUTH_PROVIDER_LABELS,
  type OAuthProvider,
} from "@/lib/auth/oauth";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";

const cardCls =
  "form-reveal flex w-full max-w-md flex-col gap-5 rounded-2xl border border-hairline-cool bg-card p-8 shadow-card";

const socialBtnCls =
  "flex flex-1 items-center justify-center gap-2 rounded-full border border-hairline-cool bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm";

const providerIcons: Record<OAuthProvider, React.ReactNode> = {
  google: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.46h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.72Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3a7.2 7.2 0 0 1-4.06 1.15 7.14 7.14 0 0 1-6.7-4.93H1.29v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.31a7.2 7.2 0 0 1 0-4.62v-3.1H1.29a12 12 0 0 0 0 10.82l4.01-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.29 6.59l4.01 3.1A7.14 7.14 0 0 1 12 4.75Z"
      />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="#181717"
        d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .5Z"
      />
    </svg>
  ),
};

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

/**
 * Social sign-in buttons. Renders nothing unless at least one provider is
 * configured (NEXT_PUBLIC_OAUTH_PROVIDERS — resolved server-side and passed in),
 * so local dev without OAuth credentials stays clean. Each button posts the
 * provider to the same `signInWithOAuth` action via the submit button's value.
 */
function SocialAuth({
  providers,
  next,
}: {
  providers: OAuthProvider[];
  next?: string;
}) {
  if (providers.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-hairline-cool" />
        <span className="text-[12px] text-fg-4">or continue with</span>
        <span className="h-px flex-1 bg-hairline-cool" />
      </div>
      <form action={signInWithOAuth} className="flex gap-2.5">
        {next && <input type="hidden" name="next" value={next} />}
        {providers.map((provider) => (
          <button
            key={provider}
            type="submit"
            name="provider"
            value={provider}
            onClick={() =>
              track({ name: "auth.oauth_clicked", props: { provider } })
            }
            className={socialBtnCls}
          >
            {providerIcons[provider]}
            {OAUTH_PROVIDER_LABELS[provider]}
          </button>
        ))}
      </form>
    </>
  );
}

// Messages for the `?error=` codes the auth callbacks redirect back with when a
// flow fails before any form was submitted (so there's no action state to show).
const SIGN_IN_ERROR_MESSAGES: Record<string, string> = {
  oauth: "Couldn't sign in with that provider. Please try again.",
  confirm: "That link is invalid or has expired. Please try again.",
};

export function SignInForm({
  next,
  providers = [],
  errorCode,
}: {
  next?: string;
  providers?: OAuthProvider[];
  errorCode?: string;
}) {
  const [state, formAction, pending] = useActionState(signIn, {});
  // Prefer a live submission error; otherwise surface the redirect error code.
  const error =
    state.error ?? (errorCode ? SIGN_IN_ERROR_MESSAGES[errorCode] : undefined);

  return (
    <div className={cardCls}>
      <form action={formAction} className="flex flex-col gap-5">
        {next && <input type="hidden" name="next" value={next} />}
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
            Sign in to Baseline
          </h1>
          <p className="text-[13px] text-fg-3">Welcome back.</p>
        </div>

        <AuthFields pending={pending} passwordAutoComplete="current-password" />

        <Link
          href="/forgot-password"
          className="-mt-2 self-end text-[13px] font-medium text-ink hover:underline"
        >
          Forgot password?
        </Link>

        {error && (
          <p role="alert" className="text-sm text-danger-fg">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          onClick={() => track({ name: "auth.sign_in_clicked" })}
          className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <SocialAuth providers={providers} next={next} />

      <p className="text-center text-[13px] text-fg-3">
        No account?{" "}
        <Link href="/sign-up" className="font-medium text-ink hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}

export function SignUpForm({
  providers = [],
}: {
  providers?: OAuthProvider[];
}) {
  const [state, formAction, pending] = useActionState(signUp, {});

  if (state.emailSent) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Check your email
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          We sent a confirmation link to your inbox. Click it to finish setting
          up your account and sign in.
        </p>
        <p className="text-[13px] text-fg-3">
          Already confirmed?{" "}
          <Link href="/sign-in" className="font-medium text-ink hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={cardCls}>
      <form action={formAction} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
            Create your account
          </h1>
          <p className="text-[13px] text-fg-3">
            Start measuring agent quality.
          </p>
        </div>

        <AuthFields pending={pending} passwordAutoComplete="new-password" />

        {state.error && (
          <p role="alert" className="text-sm text-danger-fg">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          onClick={() => track({ name: "auth.signup_started" })}
          className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>

      <SocialAuth providers={providers} />

      <p className="text-center text-[13px] text-fg-3">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

/**
 * "Forgot password" request form (public /forgot-password page). On success it
 * shows a generic "check your email" notice whether or not the address has an
 * account — see requestPasswordReset.
 */
export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, {});

  if (state.emailSent) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Check your email
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          If an account exists for that address, we&apos;ve sent a link to reset
          your password. Follow it to choose a new one.
        </p>
        <p className="text-[13px] text-fg-3">
          <Link href="/sign-in" className="font-medium text-ink hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className={cardCls}>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Reset your password
        </h1>
        <p className="text-[13px] text-fg-3">
          Enter your email and we&apos;ll send you a reset link.
        </p>
      </div>

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

      {state.error && (
        <p role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        onClick={() => track({ name: "auth.password_reset_requested" })}
        className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>

      <p className="text-center text-[13px] text-fg-3">
        Remembered it?{" "}
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

/**
 * Set-new-password form (/reset-password). Reached after the recovery link has
 * opened a session via /auth/confirm; submitting redirects into the app.
 */
export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(resetPassword, {});

  return (
    <form action={formAction} className={cardCls}>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Choose a new password
        </h1>
        <p className="text-[13px] text-fg-3">
          Pick a new password for signing in.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-[13px] font-medium text-ink">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          minLength={MIN_PASSWORD_LENGTH}
          className={inputCls}
          disabled={pending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="confirmPassword"
          className="text-[13px] font-medium text-ink"
        >
          Confirm new password
        </label>
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
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger-fg">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
      >
        {pending ? "Saving…" : "Update password"}
      </button>
    </form>
  );
}
