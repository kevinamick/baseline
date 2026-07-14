// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../messages/en.json";

// useActionState invokes these server actions; mock them as plain functions so
// the forms run client-side in the test, and assert the analytics click.
const {
  mockSignIn,
  mockSignUp,
  mockSignInWithOAuth,
  mockRequestPasswordReset,
  mockResendConfirmation,
  mockResetPassword,
  mockTrack,
} = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignInWithOAuth: vi.fn(),
  mockRequestPasswordReset: vi.fn(),
  mockResendConfirmation: vi.fn(),
  mockResetPassword: vi.fn(),
  mockTrack: vi.fn(),
}));
vi.mock("@/app/actions/auth", () => ({
  signIn: mockSignIn,
  signUp: mockSignUp,
  signInWithOAuth: mockSignInWithOAuth,
  requestPasswordReset: mockRequestPasswordReset,
  resendConfirmation: mockResendConfirmation,
  resetPassword: mockResetPassword,
}));
vi.mock("@/lib/analytics/client", () => ({ track: mockTrack }));
// next-intl's navigation entry pulls in next/navigation, unresolvable in jsdom —
// mock the locale-aware Link these forms use to a plain anchor.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import {
  SignInForm,
  SignUpForm,
  ForgotPasswordForm,
  ResetPasswordForm,
} from "./auth-form";

// Render under the real next-intl provider so useTranslations resolves against
// the actual English catalog (the e2e suite covers Spanish output). `onError`
// rethrows on a missing message so a key one of these forms calls that isn't in
// the catalog fails the render instead of silently falling back to the raw key
// path (the guard pattern from connections-list.dom.test.tsx, applied here for
// the new gated sign-up copy, #425).
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error) => {
        if (error.code === "MISSING_MESSAGE") throw error;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SignInForm", () => {
  it("renders the email/password fields and a link to sign-up", () => {
    render(<SignInForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create one" })).toHaveAttribute(
      "href",
      "/sign-up"
    );
    expect(
      screen.getByRole("link", { name: "Forgot password?" })
    ).toHaveAttribute("href", "/forgot-password");
  });

  it("surfaces a redirect error code when present", () => {
    render(<SignInForm errorCode="oauth" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't sign in with that provider"
    );
  });

  it("ignores an unknown error code", () => {
    render(<SignInForm errorCode="bogus" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides social buttons when no providers are configured", () => {
    render(<SignInForm />);
    expect(
      screen.queryByRole("button", { name: /Google/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /GitHub/ })
    ).not.toBeInTheDocument();
  });

  it("renders a button per configured provider and tracks the click", async () => {
    const user = userEvent.setup();
    render(<SignInForm providers={["google", "github"]} />);

    const google = screen.getByRole("button", { name: /Google/ });
    expect(google).toHaveValue("google");
    expect(screen.getByRole("button", { name: /GitHub/ })).toHaveValue(
      "github"
    );

    await user.click(google);
    expect(mockTrack).toHaveBeenCalledWith({
      name: "auth.oauth_clicked",
      props: { provider: "google" },
    });
  });

  it("surfaces the action's error and tracks the click on submit", async () => {
    mockSignIn.mockResolvedValue({ error: "Invalid login credentials" });
    const user = userEvent.setup();
    render(<SignInForm />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "secret1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid login credentials"
    );
    expect(mockTrack).toHaveBeenCalledWith({ name: "auth.sign_in_clicked" });
  });

  // Expired sign-up confirm link recovery (#498, reworked per review on PR
  // #500): ?error=confirm_expired swaps the WHOLE card to a focused
  // single-action state. The primary persona is an unconfirmed user, and
  // Supabase refuses password sign-in for unconfirmed accounts, so the
  // sign-in fields are not rendered at all — just the resend form (the one
  // primary CTA, collecting the email since the dead token carries none) and
  // a plain sign-in escape hatch for the already-consumed-token case (that
  // user IS confirmed; a resend would no-op silently for them).
  describe("confirm_expired error code (#498)", () => {
    it("renders the focused resend state with no sign-in fields", () => {
      render(<SignInForm errorCode="confirm_expired" />);
      expect(
        screen.getByRole("heading", {
          name: "That confirmation link expired or was already used",
        })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Resend confirmation email" })
      ).toBeEnabled();
      // Exactly one email field (the resend form's) and NO password field —
      // an unconfirmed user cannot sign in, so the form must not invite it.
      expect(screen.getAllByLabelText("Email")).toHaveLength(1);
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Sign in" })
      ).not.toBeInTheDocument();
    });

    it("offers a sign-in escape hatch back to the normal form", () => {
      render(<SignInForm errorCode="confirm_expired" />);
      // "Already confirmed? Sign in" — the consumed-token case (e.g. a
      // mail-scanner prefetch burned the link but confirmed the account)
      // needs sign-in, and the link drops the error param to restore the
      // normal form.
      expect(screen.getByText("Already confirmed?")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
        "href",
        "/sign-in"
      );
    });

    it("does not swap the card for a plain confirm error", () => {
      render(<SignInForm errorCode="confirm" />);
      expect(
        screen.queryByRole("button", { name: "Resend confirmation email" })
      ).not.toBeInTheDocument();
      // Normal sign-in form still renders with its generic banner.
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That link is invalid or has expired."
      );
    });

    it("submits the entered email and cools down after a successful resend", async () => {
      mockResendConfirmation.mockResolvedValue({ emailSent: true });
      const user = userEvent.setup();
      render(<SignInForm errorCode="confirm_expired" />);

      await user.type(screen.getByLabelText("Email"), "stale@b.com");
      await user.click(
        screen.getByRole("button", { name: "Resend confirmation email" })
      );

      expect(await screen.findByText(
        "If that address needs confirming, a new link is on its way."
      )).toBeInTheDocument();
      expect(mockResendConfirmation).toHaveBeenCalled();
      // Cooldown kicks in immediately after a submit resolves.
      expect(
        screen.getByRole("button", { name: /Resend available in 60s/ })
      ).toBeDisabled();
    });

    it("surfaces a visible rate-limit error instead of silently starting the cooldown", async () => {
      // Regression (#498): the resend control must render the one visible
      // failure resendConfirmation can return (a per-IP 429) rather than
      // swallowing it into the same disabled "cooldown" state a real send
      // produces — otherwise a rate-limited user sees no explanation and is
      // locked out for 60s as if an email actually went out.
      mockResendConfirmation.mockResolvedValue({
        error: "Too many requests. Please try again later.",
      });
      const user = userEvent.setup();
      render(<SignInForm errorCode="confirm_expired" />);

      await user.type(screen.getByLabelText("Email"), "stale@b.com");
      await user.click(
        screen.getByRole("button", { name: "Resend confirmation email" })
      );

      expect(await screen.findByText("Too many requests. Please try again later.")).toBeInTheDocument();
      // Still immediately clickable — a failed attempt doesn't burn the cooldown.
      expect(
        screen.getByRole("button", { name: "Resend confirmation email" })
      ).toBeEnabled();
      expect(
        screen.queryByText(
          "If that address needs confirming, a new link is on its way."
        )
      ).not.toBeInTheDocument();
    });

    it("keeps the sent confirmation visible past the first countdown tick", async () => {
      // Regression (#498): "sent" visibility must not be derived from
      // secondsLeft equaling its starting value — the countdown decrements
      // within 1s of arming, so that derivation made the message flash and
      // vanish almost immediately instead of persisting through the cooldown.
      // A short REAL wait (rather than vi.useFakeTimers, which deadlocked
      // combined with userEvent/React's scheduler here and leaked fake timers
      // into every later test in the file) past the first tick is the
      // reliable way to prove this without weakening the assertion.
      mockResendConfirmation.mockResolvedValue({ emailSent: true });
      render(<SignInForm errorCode="confirm_expired" />);

      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "stale@b.com" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Resend confirmation email" })
      );

      const sentText =
        "If that address needs confirming, a new link is on its way.";
      expect(await screen.findByText(sentText)).toBeInTheDocument();

      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(screen.getByText(sentText)).toBeInTheDocument();
    });
  });
});

describe("SignUpForm", () => {
  it("renders the create-account form with a link to sign-in", () => {
    render(<SignUpForm />);
    expect(
      screen.getByRole("button", { name: "Create account" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in"
    );
  });

  it("switches to the check-your-email view on success", async () => {
    mockSignUp.mockResolvedValue({ emailSent: true });
    const user = userEvent.setup();
    render(<SignUpForm />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "secret1");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    // The form (and its password field) is replaced by the confirmation notice.
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith({ name: "auth.signup_started" });
  });

  // "Check your email" resend (#498): the screen already knows the
  // just-submitted email (captured at submit time), so the resend control
  // uses a hidden field rather than asking the user to re-type it, and its
  // cooldown starts at MOUNT (the initial confirmation just went out).
  describe("resend from the check-your-email screen (#498)", () => {
    it("renders a resend control prefilled with the submitted email, cooling down from mount", async () => {
      mockSignUp.mockResolvedValue({ emailSent: true });
      const user = userEvent.setup();
      render(<SignUpForm />);

      await user.type(screen.getByLabelText("Email"), "fresh@b.com");
      await user.type(screen.getByLabelText("Password"), "secret1");
      await user.click(screen.getByRole("button", { name: "Create account" }));

      expect(await screen.findByText("Check your email")).toBeInTheDocument();
      expect(screen.getByText("Didn't get it?")).toBeInTheDocument();
      // Cooldown starts immediately at mount — no separate submit needed to
      // arm it — so the button is disabled from the first render of this view.
      const resendButton = screen.getByRole("button", {
        name: /Resend available in 60s/,
      });
      expect(resendButton).toBeDisabled();
      // No second, user-editable email field on this screen.
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    });
  });

  it("shows an error when sign-up fails", async () => {
    mockSignUp.mockResolvedValue({ error: "User already registered" });
    const user = userEvent.setup();
    render(<SignUpForm />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "secret1");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "User already registered"
    );
    // Still on the form — no confirmation view.
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
  });

  // Launch-phase Access Code gate (ADR-0017, #425): the /sign-up page resolves
  // `gated` server-side (isSignupGated()) and passes it down, so the form
  // renders the invite-only notice without knowing anything about PostHog.
  it("shows nothing extra when the gate is not up (default)", () => {
    render(<SignUpForm />);
    expect(
      screen.queryByText(/invite-only/i)
    ).not.toBeInTheDocument();
  });

  it("shows the invite-only notice up front when the gate is up", () => {
    render(<SignUpForm gated />);
    expect(
      screen.getByText(
        "Baseline is invite-only right now. Enter the email your invitation was sent to, or enter an access code below."
      )
    ).toBeInTheDocument();
    // The form itself stays usable — an invited teammate still needs it.
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create account" })
    ).toBeInTheDocument();
  });

  it("renders the translated invite-only refusal (not a raw error string) when the action reports gated", async () => {
    mockSignUp.mockResolvedValue({ gated: true });
    const user = userEvent.setup();
    render(<SignUpForm gated />);

    await user.type(screen.getByLabelText("Email"), "uninvited@b.com");
    await user.type(screen.getByLabelText("Password"), "secret1");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't find a pending invitation for that email."
    );
    // Still on the form — refusal isn't the terminal "check your email" view.
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
  });

  // Access Code field (ADR-0017, #426): rendered only while gated, and
  // deliberately NOT required — an invited teammate must still get through
  // with none (the server-side Invitation bypass ignores the field entirely).
  it("hides the access code field when the gate is not up", () => {
    render(<SignUpForm />);
    expect(screen.queryByLabelText("Access code")).not.toBeInTheDocument();
  });

  it("shows an optional (not required) access code field when the gate is up", () => {
    render(<SignUpForm gated />);
    const codeField = screen.getByLabelText("Access code");
    expect(codeField).toBeInTheDocument();
    expect(codeField).not.toBeRequired();
  });

  it.each([
    ["invalid", "We couldn't match that access code."],
    ["expired", "That access code has expired."],
    ["exhausted", "That access code has reached its redemption limit."],
  ] as const)(
    "renders the distinct %s access-code message from the action",
    async (status, expectedText) => {
      mockSignUp.mockResolvedValue({ accessCodeError: status });
      const user = userEvent.setup();
      render(<SignUpForm gated />);

      await user.type(screen.getByLabelText("Email"), "coded@b.com");
      await user.type(screen.getByLabelText("Password"), "secret1");
      await user.type(screen.getByLabelText("Access code"), "SOME-CODE");
      await user.click(screen.getByRole("button", { name: "Create account" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(expectedText);
      expect(screen.getByLabelText("Access code")).toHaveAttribute(
        "aria-invalid",
        "true"
      );
      expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
    }
  );
});

describe("ForgotPasswordForm", () => {
  it("switches to a generic check-your-email notice on success", async () => {
    mockRequestPasswordReset.mockResolvedValue({ emailSent: true });
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith({
      name: "auth.password_reset_requested",
    });
  });

  it("surfaces the action's error", async () => {
    mockRequestPasswordReset.mockResolvedValue({
      error: "Enter a valid email address",
    });
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid email address"
    );
  });
});

describe("ResetPasswordForm", () => {
  it("renders the new-password fields", () => {
    render(<ResetPasswordForm />);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update password" })
    ).toBeInTheDocument();
  });

  it("surfaces the action's error", async () => {
    mockResetPassword.mockResolvedValue({ error: "Passwords don't match." });
    const user = userEvent.setup();
    render(<ResetPasswordForm />);

    await user.type(screen.getByLabelText("New password"), "secret1");
    await user.type(screen.getByLabelText("Confirm new password"), "secret2");
    await user.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passwords don't match."
    );
  });
});
