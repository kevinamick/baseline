// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockSignOut } = vi.hoisted(() => ({ mockSignOut: vi.fn() }));
vi.mock("@/app/actions/auth", () => ({ signOut: mockSignOut }));
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

import { NavBar } from "./nav-bar";

describe("NavBar", () => {
  it("marks the active route and renders the team placeholder + sign-out", () => {
    render(<NavBar />);

    // Active state derives from the current pathname (/rubrics).
    expect(screen.getByRole("link", { name: "Rubrics" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current"
    );
    expect(screen.getByRole("link", { name: "Schedules" })).not.toHaveAttribute(
      "aria-current"
    );

    // Orgs aren't wired yet (#47) — a static "No team" placeholder stands in.
    expect(screen.getByText("No team")).toBeInTheDocument();

    // Sign-out is a server-action form; assert the control is present.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
