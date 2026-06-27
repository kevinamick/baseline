// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

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

vi.mock("@/app/actions/invitations", () => ({
  inviteMember: vi.fn(async () => ({})),
}));

import enMessages from "../../../../../../../messages/en.json";
import { InviteMemberForm } from "./invite-member-form";

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("InviteMemberForm (#344)", () => {
  it("disables the email input and submit on the free plan", () => {
    renderWithIntl(<InviteMemberForm freePlan />);

    const emailInput = screen.getByLabelText("Invite by email");
    expect(emailInput).toBeDisabled();

    const submitButton = screen.getByRole("button", { name: "Send invite" });
    expect(submitButton).toBeDisabled();
  });

  it("shows upgrade language on the free plan", () => {
    renderWithIntl(<InviteMemberForm freePlan />);

    const blocked = screen.getByTestId("invite-free-blocked");
    expect(blocked).toHaveTextContent(/upgrade to invite teammates/i);
  });

  it("renders a pricing link in the free-plan upgrade language", () => {
    renderWithIntl(<InviteMemberForm freePlan />);

    const link = screen
      .getByTestId("invite-free-blocked")
      .querySelector("a[href='/pricing']");
    expect(link).not.toBeNull();
  });

  it("leaves the form enabled on a paid plan", () => {
    renderWithIntl(<InviteMemberForm freePlan={false} />);

    const emailInput = screen.getByLabelText("Invite by email");
    expect(emailInput).not.toBeDisabled();

    const submitButton = screen.getByRole("button", { name: "Send invite" });
    expect(submitButton).not.toBeDisabled();

    expect(screen.queryByTestId("invite-free-blocked")).not.toBeInTheDocument();
  });
});
