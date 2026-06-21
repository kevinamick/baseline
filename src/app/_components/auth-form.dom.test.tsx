// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
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
  mockResetPassword,
  mockTrack,
} = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignInWithOAuth: vi.fn(),
  mockRequestPasswordReset: vi.fn(),
  mockResetPassword: vi.fn(),
  mockTrack: vi.fn(),
}));
vi.mock("@/app/actions/auth", () => ({
  signIn: mockSignIn,
  signUp: mockSignUp,
  signInWithOAuth: mockSignInWithOAuth,
  requestPasswordReset: mockRequestPasswordReset,
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
// the actual English catalog (the e2e suite covers Spanish output).
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
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
