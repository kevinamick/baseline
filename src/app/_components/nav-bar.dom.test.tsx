// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// NavBar reads its identity from AuthProvider and hands it to NavBarClient, so it
// pulls in the same interactive surfaces; stub their side-effecting deps exactly
// as the NavBarClient test does so this stays a pure context-wiring check.
vi.mock("@/app/actions/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/analytics/client", () => ({ reset: vi.fn() }));
vi.mock("@/app/actions/active-org", () => ({ switchOrg: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/rubrics",
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
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json"))
    .default as unknown as Record<string, Record<string, string>>;
  return {
    useTranslations: (ns: string) => (key: string) => en[ns]?.[key] ?? key,
  };
});

import { NavBar } from "./nav-bar";
import { AuthProvider } from "./auth-context";

describe("NavBar (context-sourced)", () => {
  it("renders the active org + email from the AuthProvider seed", async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider
        orgs={[{ orgId: "org-a", name: "Acme Engineering" }]}
        activeOrgId="org-a"
        email="owner@acme.com"
        canManageTeam
      >
        <NavBar />
      </AuthProvider>,
    );

    // Active org name comes straight from context.
    expect(screen.getByText("Acme Engineering")).toBeInTheDocument();

    // Email is surfaced via the account menu.
    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByText("owner@acme.com")).toBeInTheDocument();
    // canManageTeam=true reveals the team/billing links.
    expect(
      screen.getByRole("link", { name: "Team settings" }),
    ).toBeInTheDocument();
  });

  it("falls back to the empty defaults with no provider", () => {
    render(<NavBar />);
    expect(screen.getByText("No team")).toBeInTheDocument();
  });

  it("hides team-manage links when canManageTeam is false", async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider
        orgs={[{ orgId: "org-a", name: "Acme Engineering" }]}
        activeOrgId="org-a"
        email="member@acme.com"
        canManageTeam={false}
      >
        <NavBar />
      </AuthProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(
      screen.queryByRole("link", { name: "Team settings" }),
    ).not.toBeInTheDocument();
  });
});
