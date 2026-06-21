// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockSignOut, mockReset, mockSwitchOrg } = vi.hoisted(() => ({
  mockSignOut: vi.fn(),
  mockReset: vi.fn(),
  mockSwitchOrg: vi.fn(),
}));
vi.mock("@/app/actions/auth", () => ({ signOut: mockSignOut }));
vi.mock("@/lib/analytics/client", () => ({ reset: mockReset }));
vi.mock("@/app/actions/active-org", () => ({ switchOrg: mockSwitchOrg }));
// The nav uses next-intl's locale-aware navigation; stub it with a plain anchor
// and a fixed pathname so route-active logic stays deterministic.
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
// Resolve translations against the real English catalog so existing assertions
// (which look for the English labels) keep working without an intl provider.
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json"))
    .default as unknown as Record<string, Record<string, string>>;
  return {
    useTranslations: (ns: string) => (key: string) => en[ns]?.[key] ?? key,
  };
});
vi.mock("next/image", () => ({
  default: ({ alt = "", src }: { alt?: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} src={typeof src === "string" ? src : ""} />
  ),
}));

import { NavBarClient } from "./nav-bar-client";

const acme = { orgId: "org-a", name: "Acme Engineering" };
const beta = { orgId: "org-b", name: "Beta" };

describe("NavBarClient", () => {
  it("marks the active route and shows the org name + initials", () => {
    render(
      <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
    );

    expect(screen.getByRole("link", { name: "Rubrics" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current"
    );

    // Org display sources the active membership org, with derived initials.
    expect(screen.getByText("Acme Engineering")).toBeInTheDocument();
    expect(screen.getByText("AE")).toBeInTheDocument();
  });

  it("falls back to a 'No team' label when there is no org", () => {
    render(<NavBarClient orgs={[]} activeOrgId={null} email="owner@acme.com" />);
    expect(screen.getByText("No team")).toBeInTheDocument();
  });

  it("renders a static pill (no switcher) for a single org", () => {
    render(
      <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
    );
    expect(
      screen.queryByRole("button", { name: "Switch team" })
    ).not.toBeInTheDocument();
  });

  it("opens a switcher listing the orgs with the active one marked", async () => {
    const user = userEvent.setup();
    render(
      <NavBarClient
        orgs={[acme, beta]}
        activeOrgId="org-b"
        email="owner@acme.com"
      />
    );

    await user.click(screen.getByRole("button", { name: "Switch team" }));

    const menu = screen.getByRole("menu");
    // The active org is marked, not a switch target.
    const active = within(menu).getByText("Beta").closest('[role="menuitem"]');
    expect(active).toHaveAttribute("aria-current", "true");
    // The other org is a submit button posting switchOrg with its id.
    const other = within(menu).getByRole("menuitem", { name: "Acme Engineering" });
    expect(other).toHaveAttribute("type", "submit");
    const form = other.closest("form");
    expect(form?.querySelector('input[name="orgId"]')).toHaveValue("org-a");
  });

  it("dispatches switchOrg when a team is selected", async () => {
    // Regression: the submit button must not close the popover in its onClick —
    // doing so unmounts the form before the server action dispatches, silently
    // no-opping the switch.
    const user = userEvent.setup();
    render(
      <NavBarClient orgs={[acme, beta]} activeOrgId="org-b" email="u@acme.com" />
    );
    await user.click(screen.getByRole("button", { name: "Switch team" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Acme Engineering" })
    );

    expect(mockSwitchOrg).toHaveBeenCalledTimes(1);
    const submitted = mockSwitchOrg.mock.calls[0][0] as FormData;
    expect(submitted.get("orgId")).toBe("org-a");
  });

  it("optimistically shows the picked team while the switch is in flight", async () => {
    // Hold the action pending so the optimistic state stays applied.
    let release!: () => void;
    mockSwitchOrg.mockImplementation(
      () => new Promise<void>((r) => (release = r))
    );
    const user = userEvent.setup();
    render(
      <NavBarClient orgs={[acme, beta]} activeOrgId="org-b" email="u@acme.com" />
    );

    const trigger = screen.getByRole("button", { name: "Switch team" });
    expect(trigger).toHaveTextContent("Beta");

    await user.click(trigger);
    await user.click(
      screen.getByRole("menuitem", { name: "Acme Engineering" })
    );

    // Picker reflects the selection immediately — no wait for the server.
    expect(trigger).toHaveTextContent("Acme Engineering");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    release();
  });

  it("closes the switcher once the active org changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NavBarClient orgs={[acme, beta]} activeOrgId="org-b" email="u@acme.com" />
    );
    await user.click(screen.getByRole("button", { name: "Switch team" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // The server action revalidates and the nav re-renders with the new active
    // org; that prop change is what closes the popover.
    rerender(
      <NavBarClient orgs={[acme, beta]} activeOrgId="org-a" email="u@acme.com" />
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the switcher on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <NavBarClient
        orgs={[acme, beta]}
        activeOrgId="org-a"
        email="owner@acme.com"
      />
    );
    const trigger = screen.getByRole("button", { name: "Switch team" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens the account menu and reveals the email + sign-out", async () => {
    const user = userEvent.setup();
    render(
      <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
    );

    // Menu is closed initially.
    expect(screen.queryByText("Signed in as")).not.toBeInTheDocument();

    // The avatar toggles the menu open.
    await user.click(screen.getByRole("button", { name: "Account" }));

    expect(screen.getByText("Signed in as")).toBeInTheDocument();
    expect(screen.getByText("owner@acme.com")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage account" })
    ).toHaveAttribute("href", "/settings/account");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    await user.click(trigger);
    expect(screen.getByText("Signed in as")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByText("Signed in as")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("fires analytics reset() when sign-out is clicked", async () => {
    const user = userEvent.setup();
    render(
      <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
    );

    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(mockReset).toHaveBeenCalled();
  });

  describe("NotificationBell", () => {
    it("renders the bell button", () => {
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );
      expect(
        screen.getByRole("button", { name: "Notifications" })
      ).toBeInTheDocument();
    });

    it("bell popover is closed initially", () => {
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );
      expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    });

    it("opens the notification popover on click and shows empty state", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );

      await user.click(screen.getByRole("button", { name: "Notifications" }));

      expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    });

    it("sets aria-expanded correctly when toggling", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );

      const button = screen.getByRole("button", { name: "Notifications" });
      expect(button).toHaveAttribute("aria-expanded", "false");

      await user.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");

      await user.click(button);
      expect(button).toHaveAttribute("aria-expanded", "false");
    });

    it("closes the popover on a second click", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );

      const button = screen.getByRole("button", { name: "Notifications" });
      await user.click(button);
      expect(screen.getByText("You're all caught up")).toBeInTheDocument();

      await user.click(button);
      expect(
        screen.queryByText("You're all caught up")
      ).not.toBeInTheDocument();
    });

    it("closes on Escape and restores focus to the trigger", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );

      const button = screen.getByRole("button", { name: "Notifications" });
      await user.click(button);
      expect(screen.getByText("You're all caught up")).toBeInTheDocument();

      await user.keyboard("{Escape}");

      expect(
        screen.queryByText("You're all caught up")
      ).not.toBeInTheDocument();
      expect(button).toHaveFocus();
    });

    it("closes when clicking outside the popover", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient orgs={[acme]} activeOrgId="org-a" email="owner@acme.com" />
      );

      await user.click(screen.getByRole("button", { name: "Notifications" }));
      expect(screen.getByText("You're all caught up")).toBeInTheDocument();

      await user.click(document.body);
      expect(
        screen.queryByText("You're all caught up")
      ).not.toBeInTheDocument();
    });
  });
});
