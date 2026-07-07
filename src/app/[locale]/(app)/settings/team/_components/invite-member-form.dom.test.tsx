// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { inviteMember } from "@/app/actions/invitations";

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// Resolves only when the test calls `release()`, so we can assert on the
// in-flight pending state before the transition settles.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const mockedInviteMember = vi.mocked(inviteMember);

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

describe("InviteMemberForm submission", () => {
  beforeEach(() => {
    mockedInviteMember.mockReset();
    mockedInviteMember.mockResolvedValue({});
  });

  it("shows the pending label and disables the controls while the action is in flight", async () => {
    const { promise, resolve } = deferred<{ sentTo?: string; error?: string }>();
    mockedInviteMember.mockReturnValue(promise);
    const user = userEvent.setup();
    renderWithIntl(<InviteMemberForm />);

    await user.type(screen.getByLabelText("Invite by email"), "a@b.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    const pendingButton = await screen.findByRole("button", { name: "Sending…" });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByLabelText("Invite by email")).toBeDisabled();

    resolve({ sentTo: "a@b.com" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send invite" }),
      ).not.toBeDisabled(),
    );
  });

  it("shows a success message with the invited email on success", async () => {
    mockedInviteMember.mockResolvedValue({ sentTo: "teammate@company.com" });
    const user = userEvent.setup();
    renderWithIntl(<InviteMemberForm />);

    await user.type(
      screen.getByLabelText("Invite by email"),
      "teammate@company.com",
    );
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invitation sent to teammate@company.com.",
    );
    expect(mockedInviteMember).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-seat-limit error inline with an accessible association to the input", async () => {
    mockedInviteMember.mockResolvedValue({
      error: "This person has already been invited.",
    });
    const user = userEvent.setup();
    renderWithIntl(<InviteMemberForm />);

    await user.type(screen.getByLabelText("Invite by email"), "dup@b.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This person has already been invited.");
    expect(alert).toHaveAttribute("id", "invite-email-error");

    const emailInput = screen.getByLabelText("Invite by email");
    expect(emailInput).toHaveAttribute("aria-invalid", "true");
    expect(emailInput).toHaveAttribute("aria-describedby", "invite-email-error");

    // No seat-limit modal for a plain error.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("surfaces an already-a-member error the same way as any other refusal", async () => {
    mockedInviteMember.mockResolvedValue({
      error: "This person is already a member of your team.",
    });
    const user = userEvent.setup();
    renderWithIntl(<InviteMemberForm />);

    await user.type(screen.getByLabelText("Invite by email"), "member@b.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This person is already a member of your team.",
    );
  });
});

describe("InviteMemberForm seat-limit upsell (#349)", () => {
  beforeEach(() => {
    mockedInviteMember.mockReset();
    mockedInviteMember.mockResolvedValue({});
  });

  async function triggerSeatLimitError(user: ReturnType<typeof userEvent.setup>) {
    mockedInviteMember.mockResolvedValue({
      error: "Your team is on the Free plan — upgrade to invite teammates.",
    });
    renderWithIntl(<InviteMemberForm />);
    await user.type(screen.getByLabelText("Invite by email"), "new@b.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
  }

  it("opens a modal upsell instead of an inline error when the server refuses on a seat limit", async () => {
    const user = userEvent.setup();
    await triggerSeatLimitError(user);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Seat limit reached");
    expect(screen.getByTestId("seat-limit-upsell-message")).toHaveTextContent(
      "Your team is on the Free plan, which includes 1 seat. Upgrade to invite more teammates.",
    );
    expect(
      screen.getByRole("button", { name: "Upgrade" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // The seat-limit error is intercepted by the modal, not the inline alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const emailInput = screen.getByLabelText("Invite by email");
    expect(emailInput).not.toHaveAttribute("aria-describedby");
  });

  it("navigates to /pricing when the upsell is confirmed", async () => {
    const user = userEvent.setup();
    await triggerSeatLimitError(user);
    await screen.findByRole("alertdialog");

    const originalLocation = window.location;
    // @ts-expect-error -- reassigning a read-only global for the test
    delete window.location;
    // @ts-expect-error -- minimal stub sufficient for an href assignment
    window.location = { ...originalLocation, href: originalLocation.href };

    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(window.location.href).toBe("/pricing");

    // @ts-expect-error -- restoring the real Location object
    window.location = originalLocation;
  });

  it("dismisses the upsell on cancel without leaving an inline error behind", async () => {
    const user = userEvent.setup();
    await triggerSeatLimitError(user);
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reopens the upsell for a fresh seat-limit error after a prior one was dismissed", async () => {
    const user = userEvent.setup();
    await triggerSeatLimitError(user);
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    mockedInviteMember.mockResolvedValue({
      error: "Your plan limits you to 1 seat — upgrade to invite teammates.",
    });
    await user.clear(screen.getByLabelText("Invite by email"));
    await user.type(screen.getByLabelText("Invite by email"), "second@b.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(mockedInviteMember).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });
});
