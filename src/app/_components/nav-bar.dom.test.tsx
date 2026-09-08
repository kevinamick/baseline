// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  it("renders the Workspace name from the AuthProvider seed and the settings links", async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider workspaceName="Acme Engineering" plan="free">
        <NavBar />
      </AuthProvider>,
    );

    expect(screen.getAllByText("Acme Engineering").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("link", { name: "Provider keys" })).toHaveAttribute(
      "href",
      "/settings/team",
    );
    expect(screen.getByRole("link", { name: "Connections" })).toBeInTheDocument();
  });

  it("falls back to the Local Workspace default with no provider", () => {
    render(<NavBar />);
    expect(screen.getAllByText("Local Workspace").length).toBeGreaterThan(0);
  });
});
