// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));
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

import { SignInCta } from "./sign-in-cta";
import { SignUpCta } from "./sign-up-cta";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SignInCta", () => {
  it("links to /sign-in, forwards className, and tracks the click", async () => {
    const user = userEvent.setup();
    render(<SignInCta className="cta-class">Sign in</SignInCta>);

    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link).toHaveAttribute("href", "/sign-in");
    expect(link).toHaveClass("cta-class");

    await user.click(link);
    expect(mockTrack).toHaveBeenCalledWith({ name: "auth.sign_in_clicked" });
  });
});

describe("SignUpCta", () => {
  it("links to /sign-up and tracks the click", async () => {
    const user = userEvent.setup();
    render(<SignUpCta className="cta-class">Get started</SignUpCta>);

    const link = screen.getByRole("link", { name: "Get started" });
    expect(link).toHaveAttribute("href", "/sign-up");

    await user.click(link);
    expect(mockTrack).toHaveBeenCalledWith({ name: "auth.signup_started" });
  });
});
