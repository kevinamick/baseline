// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

const WS = "Acme Engineering";

describe("NavBarClient", () => {
  it("marks the active route and shows the Workspace name + initials", () => {
    render(<NavBarClient workspaceName={WS} />);

    const rubrics = screen.getByRole("link", { name: "Rubrics" });
    expect(rubrics).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getAllByText(WS).length).toBeGreaterThan(0);
    expect(screen.getAllByText("AE").length).toBeGreaterThan(0);
  });

  it("opens the settings menu with the Workspace name and settings links", async () => {
    const user = userEvent.setup();
    render(<NavBarClient workspaceName={WS} />);

    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute(
      "href",
      "/settings/connections",
    );
    expect(screen.getByRole("link", { name: "Provider keys" })).toHaveAttribute(
      "href",
      "/settings/team",
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<NavBarClient workspaceName={WS} />);

    const trigger = screen.getByRole("button", { name: "Settings" });
    await user.click(trigger);
    expect(screen.getByText("Workspace")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  describe("NotificationBell", () => {
    it("renders the bell button", () => {
      render(
        <NavBarClient workspaceName={WS} />
      );
      expect(
        screen.getByRole("button", { name: "Notifications" })
      ).toBeInTheDocument();
    });

    it("bell popover is closed initially", () => {
      render(
        <NavBarClient workspaceName={WS} />
      );
      expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    });

    it("opens the notification popover on click and shows empty state", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient workspaceName={WS} />
      );

      await user.click(screen.getByRole("button", { name: "Notifications" }));

      expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    });

    it("sets aria-expanded correctly when toggling", async () => {
      const user = userEvent.setup();
      render(
        <NavBarClient workspaceName={WS} />
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
        <NavBarClient workspaceName={WS} />
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
        <NavBarClient workspaceName={WS} />
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
        <NavBarClient workspaceName={WS} />
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
