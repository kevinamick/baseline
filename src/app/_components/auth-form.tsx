"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  signIn,
  signUp,
  signInWithOAuth,
  requestPasswordReset,
  resendConfirmation,
  resetPassword,
} from "@/app/actions/auth";
import { track } from "@/lib/analytics/client";
import {
  OAUTH_PROVIDER_LABELS,
  type OAuthProvider,
} from "@/lib/auth/oauth";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { RESEND_CONFIRMATION_COOLDOWN_SECONDS } from "@/lib/auth/resend-confirmation";

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
  const t = useTranslations("Auth");
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-[13px] font-medium text-ink">
          {t("emailLabel")}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder={t("emailPlaceholder")}
          className={inputCls}
          disabled={pending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-[13px] font-medium text-ink">
          {t("passwordLabel")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
          minLength={MIN_PASSWORD_LENGTH}
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
  const t = useTranslations("Auth");
  if (providers.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-hairline-cool" />
        <span className="text-[12px] text-fg-4">{t("orContinueWith")}</span>
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

// Translation keys for the `?error=` codes the auth callbacks redirect back with
// when a flow fails before any form was submitted (so there's no action state to
// show). Keyed by code → Auth namespace key. `confirm_expired` (#498) is NOT in
// this map: it swaps the whole card to the focused resend state below rather
// than banner-ing the normal form.
const SIGN_IN_ERROR_KEYS: Record<string, "errorOauth" | "errorConfirm"> = {
  oauth: "errorOauth",
  confirm: "errorConfirm",
};

/**
 * Shared "Resend confirmation email" control (#498). Two call sites:
 *  - the "check your email" screen (`SignUpForm`'s `emailSent` view), which
 *    already knows the just-submitted email — passed as `email` and rendered
 *    as a hidden field — and starts its cooldown at MOUNT: the initial
 *    confirmation just went out, and prod's GoTrue `smtp_max_frequency` (60s)
 *    would refuse an immediate resend anyway.
 *  - the sign-in page's focused expired-confirm-link state, which has no known
 *    email (the dead token carries none) — `email` is omitted so an editable
 *    field renders instead — and cools down only AFTER a submit, since there's
 *    nothing to protect against before the first click. There the resend is
 *    the card's ONE action, so `primaryCta` styles the submit as the standard
 *    full-width primary button instead of the inline text action.
 * Every `resendConfirmation` response is the identical anti-enumeration
 * generic success, so this never branches UI on failure — only on
 * pending/cooldown state.
 */
function ResendConfirmationForm({
  email,
  primaryCta = false,
}: {
  email?: string;
  primaryCta?: boolean;
}) {
  const t = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(resendConfirmation, {});
  const [secondsLeft, setSecondsLeft] = useState(
    email ? RESEND_CONFIRMATION_COOLDOWN_SECONDS : 0
  );
  // Tracks the "sent" confirmation as its own flag rather than deriving it
  // from `secondsLeft === COOLDOWN` — the countdown effect below decrements
  // that value within ~1s of arming, so an equality check against it would
  // make the confirmation flash and vanish almost immediately.
  const [justSent, setJustSent] = useState(false);

  // Detects "the action just resolved" (pending flipped true → false) DURING
  // RENDER — React's documented pattern for deriving state from a change
  // since the last render — rather than a useEffect whose body would call
  // setState synchronously (which cascades an extra render for no benefit
  // over computing it inline here).
  const [prevPending, setPrevPending] = useState(pending);
  if (prevPending !== pending) {
    setPrevPending(pending);
    // Only a genuine generic success (state.emailSent) arms the cooldown and
    // the "sent" confirmation. The one visible failure this action can
    // return — a per-IP 429 (state.error, rendered below) — leaves both
    // alone, so a rate-limited caller sees the real error instead of a
    // cooldown implying a mail went out.
    if (prevPending && !pending && state.emailSent) {
      setSecondsLeft(RESEND_CONFIRMATION_COOLDOWN_SECONDS);
      setJustSent(true);
    }
  }

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  const disabled = pending || secondsLeft > 0;

  return (
    <form
      action={formAction}
      onSubmit={() => setJustSent(false)}
      className={primaryCta ? "flex flex-col gap-4" : "flex flex-col gap-2"}
    >
      {email ? (
        <input type="hidden" name="email" value={email} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="resendEmail" className="text-[13px] font-medium text-ink">
            {t("emailLabel")}
          </label>
          <input
            id="resendEmail"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder={t("emailPlaceholder")}
            className={inputCls}
            disabled={pending}
          />
        </div>
      )}
      <button
        type="submit"
        disabled={disabled}
        className={
          primaryCta
            ? "w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
            : "self-start text-[13px] font-medium text-ink hover:underline disabled:cursor-not-allowed disabled:text-fg-4 disabled:no-underline disabled:hover:no-underline"
        }
      >
        {secondsLeft > 0
          ? t("resendConfirmationCooldown", { seconds: secondsLeft })
          : pending
            ? t("resendConfirmationPending")
            : t("resendConfirmation")}
      </button>
      {state.error && (
        <p role="alert" className="text-[13px] text-danger-fg">
          {state.error}
        </p>
      )}
      {justSent && (
        <p className="text-[13px] text-fg-3">{t("resendConfirmationSent")}</p>
      )}
    </form>
  );
}

// Translation keys for a failed Access Code claim (ADR-0017, #426) — distinct
// from `gated` (no code submitted at all) and from a raw Supabase `error`.
const ACCESS_CODE_ERROR_KEYS: Record<
  "invalid" | "expired" | "exhausted",
  "accessCodeErrorInvalid" | "accessCodeErrorExpired" | "accessCodeErrorExhausted"
> = {
  invalid: "accessCodeErrorInvalid",
  expired: "accessCodeErrorExpired",
  exhausted: "accessCodeErrorExhausted",
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
  const t = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(signIn, {});
  // Prefer a live submission error; otherwise surface the redirect error code.
  const errorKey = errorCode ? SIGN_IN_ERROR_KEYS[errorCode] : undefined;
  const error = state.error ?? (errorKey ? t(errorKey) : undefined);

  // Focused expired-confirm-link recovery state (#498, reworked per review on
  // PR #500): the primary persona landing here is an UNCONFIRMED user, and
  // Supabase refuses password sign-in for unconfirmed accounts, so rendering
  // the sign-in fields would invite a doomed attempt. The card swaps entirely
  // to one action — collect the email (the dead token carries none) and
  // resend — plus a plain sign-in escape hatch: GoTrue's "invalid or expired"
  // also covers an already-CONSUMED token (e.g. a mail-scanner prefetch that
  // confirmed the account and burned the link), and that user is confirmed,
  // so sign-in is their correct path while a resend would no-op silently into
  // the generic anti-enumeration success.
  if (errorCode === "confirm_expired") {
    return (
      <div className={cardCls}>
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
            {t("confirmExpiredTitle")}
          </h1>
          <p className="text-[13px] text-fg-3">{t("confirmExpiredMessage")}</p>
        </div>
        <ResendConfirmationForm primaryCta />
        <p className="text-center text-[13px] text-fg-3">
          {t("alreadyConfirmed")}{" "}
          <Link href="/sign-in" className="font-medium text-ink hover:underline">
            {t("signIn")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={cardCls}>
      <form action={formAction} className="flex flex-col gap-5">
        {next && <input type="hidden" name="next" value={next} />}
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
            {t("signInTitle")}
          </h1>
          <p className="text-[13px] text-fg-3">{t("signInSubtitle")}</p>
        </div>

        <AuthFields pending={pending} passwordAutoComplete="current-password" />

        <Link
          href="/forgot-password"
          className="-mt-2 self-end text-[13px] font-medium text-ink hover:underline"
        >
          {t("forgotPassword")}
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
          {pending ? t("signInPending") : t("signIn")}
        </button>
      </form>

      <SocialAuth providers={providers} next={next} />

      <p className="text-center text-[13px] text-fg-3">
        {t("noAccount")}{" "}
        <Link href="/sign-up" className="font-medium text-ink hover:underline">
          {t("createOne")}
        </Link>
      </p>
    </div>
  );
}

export function SignUpForm({
  providers = [],
  gated = false,
}: {
  providers?: OAuthProvider[];
  /** The launch-phase Access Code gate (ADR-0017, #425/#426) is currently up —
   *  the form still accepts an email/password (an invited teammate needs to
   *  enter theirs) and now also renders the Access Code field, but shows a
   *  notice so an uninvited visitor understands up front that this is
   *  invite-only. The code field is deliberately NOT HTML-`required`: a
   *  pending-Invitation submission bypasses everything unconditionally
   *  server-side (#425) with no code, so a hard client-side requirement would
   *  block an invited teammate who has none. Resolved server-side by the
   *  /sign-up page via the same `isSignupGated()` the action enforces with,
   *  so this can never disagree with what the action actually does on
   *  submit. */
  gated?: boolean;
}) {
  const t = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(signUp, {});
  // Captured at submit time (not read from `state`, which carries no email
  // field) so the "check your email" screen's resend control can prefill the
  // just-submitted address (#498).
  const [submittedEmail, setSubmittedEmail] = useState("");

  if (state.emailSent) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          {t("checkEmailTitle")}
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          {t("signUpEmailSent")}
        </p>
        <div className="flex flex-col gap-2 border-t border-hairline-cool pt-4">
          <p className="text-[13px] text-fg-3">{t("resendConfirmationPrompt")}</p>
          <ResendConfirmationForm email={submittedEmail} />
        </div>
        <p className="text-[13px] text-fg-3">
          {t("alreadyConfirmed")}{" "}
          <Link href="/sign-in" className="font-medium text-ink hover:underline">
            {t("signIn")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={cardCls}>
      <form
        action={formAction}
        onSubmit={(e) => {
          setSubmittedEmail(
            String(new FormData(e.currentTarget).get("email") ?? "")
          );
        }}
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
            {t("signUpTitle")}
          </h1>
          <p className="text-[13px] text-fg-3">
            {t("signUpSubtitle")}
          </p>
        </div>

        {gated && (
          <p className="rounded-lg border border-hairline-cool bg-card-warm px-3.5 py-2.5 text-[13px] text-fg-2">
            {t("signUpGatedNotice")}
          </p>
        )}

        <AuthFields pending={pending} passwordAutoComplete="new-password" />

        {gated && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="accessCode"
              className="text-[13px] font-medium text-ink"
            >
              {t("accessCodeLabel")}
            </label>
            <input
              id="accessCode"
              name="accessCode"
              type="text"
              autoComplete="off"
              placeholder={t("accessCodePlaceholder")}
              aria-invalid={!!state.accessCodeError}
              className={
                state.accessCodeError ? `${inputCls} border-danger` : inputCls
              }
              disabled={pending}
            />
            {state.accessCodeError && (
              <p role="alert" className="text-[13px] text-danger-fg">
                {t(ACCESS_CODE_ERROR_KEYS[state.accessCodeError])}
              </p>
            )}
          </div>
        )}

        {state.gated ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t("signUpGatedMessage")}
          </p>
        ) : state.retryable ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t("signUpRetryMessage")}
          </p>
        ) : (
          state.error && (
            <p role="alert" className="text-sm text-danger-fg">
              {state.error}
            </p>
          )
        )}

        <button
          type="submit"
          disabled={pending}
          onClick={() => track({ name: "auth.signup_started" })}
          className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
        >
          {pending ? t("signUpPending") : t("createAccount")}
        </button>
      </form>

      <SocialAuth providers={providers} />

      <p className="text-center text-[13px] text-fg-3">
        {t("alreadyHaveAccount")}{" "}
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          {t("signIn")}
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
  const t = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(requestPasswordReset, {});

  if (state.emailSent) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          {t("checkEmailTitle")}
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          {t("forgotEmailSent")}
        </p>
        <p className="text-[13px] text-fg-3">
          <Link href="/sign-in" className="font-medium text-ink hover:underline">
            {t("backToSignIn")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className={cardCls}>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          {t("forgotTitle")}
        </h1>
        <p className="text-[13px] text-fg-3">
          {t("forgotSubtitle")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-[13px] font-medium text-ink">
          {t("emailLabel")}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder={t("emailPlaceholder")}
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
        {pending ? t("forgotPending") : t("sendResetLink")}
      </button>

      <p className="text-center text-[13px] text-fg-3">
        {t("rememberedIt")}{" "}
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          {t("signIn")}
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
  const t = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(resetPassword, {});

  return (
    <form action={formAction} className={cardCls}>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          {t("resetTitle")}
        </h1>
        <p className="text-[13px] text-fg-3">
          {t("resetSubtitle")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-[13px] font-medium text-ink">
          {t("newPasswordLabel")}
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
          {t("confirmPasswordLabel")}
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
        {pending ? t("resetPending") : t("updatePassword")}
      </button>
    </form>
  );
}
