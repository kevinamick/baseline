// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// useActionState invokes these server actions; mock them as plain functions so
// the forms run client-side in the test, and assert the analytics click.
const { mockSignIn, mockSignUp, mockTrack } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockSignUp: vi.fn(),
  mockTrack: vi.fn(),
}));
vi.mock("@/app/actions/auth", () => ({
  signIn: mockSignIn,
  signUp: mockSignUp,
}));
vi.mock("@/lib/analytics/client", () => ({ track: mockTrack }));
vi.mock("next/link", () => ({
  default: ({
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

import { SignInForm, SignUpForm } from "./auth-form";

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
