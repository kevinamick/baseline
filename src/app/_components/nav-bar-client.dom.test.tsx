// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockSignOut, mockReset } = vi.hoisted(() => ({
  mockSignOut: vi.fn(),
  mockReset: vi.fn(),
}));
vi.mock("@/app/actions/auth", () => ({ signOut: mockSignOut }));
vi.mock("@/lib/analytics/client", () => ({ reset: mockReset }));
vi.mock("next/navigation", () => ({ usePathname: () => "/rubrics" }));
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
vi.mock("next/image", () => ({
  default: ({ alt = "", src }: { alt?: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} src={typeof src === "string" ? src : ""} />
  ),
}));

import { NavBarClient } from "./nav-bar-client";

describe("NavBarClient", () => {
  it("marks the active route and shows the org name + initials", () => {
    render(<NavBarClient orgName="Acme Engineering" email="owner@acme.com" />);

    expect(screen.getByRole("link", { name: "Rubrics" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current"
    );

    // Org display sources the membership org, with derived initials.
    expect(screen.getByText("Acme Engineering")).toBeInTheDocument();
    expect(screen.getByText("AE")).toBeInTheDocument();
  });

  it("falls back to a 'No team' label when there is no org", () => {
    render(<NavBarClient orgName={null} email="owner@acme.com" />);
    expect(screen.getByText("No team")).toBeInTheDocument();
  });

  it("opens the account menu and reveals the email + sign-out", async () => {
    const user = userEvent.setup();
    render(<NavBarClient orgName="Acme Engineering" email="owner@acme.com" />);

    // Menu is closed initially.
    expect(screen.queryByText("Signed in as")).not.toBeInTheDocument();

    // The avatar toggles the menu open.
    await user.click(screen.getByRole("button", { name: "Account" }));

    expect(screen.getByText("Signed in as")).toBeInTheDocument();
    expect(screen.getByText("owner@acme.com")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Manage account" })
    ).toHaveAttribute("href", "/settings/account");
    expect(
      screen.getByRole("menuitem", { name: "Sign out" })
    ).toBeInTheDocument();
  });

  it("fires analytics reset() when sign-out is clicked", async () => {
    const user = userEvent.setup();
    render(<NavBarClient orgName="Acme Engineering" email="owner@acme.com" />);

    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(mockReset).toHaveBeenCalled();
  });
});
