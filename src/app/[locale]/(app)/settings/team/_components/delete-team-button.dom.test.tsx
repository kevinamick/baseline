// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

const { deleteOrganization } = vi.hoisted(() => ({
  deleteOrganization: vi.fn(),
}));

vi.mock("@/app/actions/orgs", () => ({
  deleteOrganization,
}));

import enMessages from "../../../../../../../messages/en.json";
import { DeleteTeamButton } from "./delete-team-button";

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      onError={(error) => {
        if (error.code === "MISSING_MESSAGE") throw error;
      }}
    >
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

describe("DeleteTeamButton", () => {
  beforeEach(() => {
    deleteOrganization.mockReset();
  });

  it("renders the danger-zone trigger collapsed, with no delete action visible yet", () => {
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    const trigger = screen.getByRole("button", { name: "Delete this team" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    expect(
      screen.queryByRole("button", { name: "Delete forever" }),
    ).not.toBeInTheDocument();
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it("expands to reveal the consequence copy and the delete-forever button", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    await user.click(screen.getByRole("button", { name: "Delete this team" }));

    expect(
      screen.getByRole("button", { name: "Delete this team" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(/This permanently deletes/),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete forever" }),
    ).toBeInTheDocument();
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it("collapses again on a second trigger click without ever invoking the action", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    const trigger = screen.getByRole("button", { name: "Delete this team" });
    await user.click(trigger);
    expect(
      screen.getByRole("button", { name: "Delete forever" }),
    ).toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "Delete forever" }),
    ).not.toBeInTheDocument();
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it("calls deleteOrganization with no arguments on confirm and shows no error on success", async () => {
    deleteOrganization.mockResolvedValue({});
    const user = userEvent.setup();
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    await user.click(screen.getByRole("button", { name: "Delete this team" }));
    await user.click(screen.getByRole("button", { name: "Delete forever" }));

    await waitFor(() => expect(deleteOrganization).toHaveBeenCalledTimes(1));
    expect(deleteOrganization).toHaveBeenCalledWith();

    // Success redirects server-side (mocked away here); no error text renders.
    expect(
      screen.queryByText("Could not delete the team. Please try again."),
    ).not.toBeInTheDocument();
  });

  it("shows the deleting label and disables the button while the action is in flight", async () => {
    const { promise, resolve } = deferred<{ error?: string }>();
    deleteOrganization.mockReturnValue(promise);
    const user = userEvent.setup();
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    await user.click(screen.getByRole("button", { name: "Delete this team" }));
    await user.click(screen.getByRole("button", { name: "Delete forever" }));

    const pendingButton = await screen.findByRole("button", {
      name: "Deleting…",
    });
    expect(pendingButton).toBeDisabled();

    resolve({});
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete forever" }),
      ).not.toBeDisabled(),
    );
  });

  it("renders the error message from the action and re-enables the button, without discarding the confirm panel", async () => {
    deleteOrganization.mockResolvedValue({
      error: "Could not delete the team. Please try again.",
    });
    const user = userEvent.setup();
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    await user.click(screen.getByRole("button", { name: "Delete this team" }));
    await user.click(screen.getByRole("button", { name: "Delete forever" }));

    expect(
      await screen.findByText("Could not delete the team. Please try again."),
    ).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Delete forever" });
    expect(retryButton).not.toBeDisabled();
  });

  it("clears a prior error once a retry is kicked off", async () => {
    deleteOrganization.mockResolvedValueOnce({
      error: "Could not delete the team. Please try again.",
    });
    const user = userEvent.setup();
    renderWithIntl(<DeleteTeamButton teamName="Acme" />);

    await user.click(screen.getByRole("button", { name: "Delete this team" }));
    await user.click(screen.getByRole("button", { name: "Delete forever" }));
    expect(
      await screen.findByText("Could not delete the team. Please try again."),
    ).toBeInTheDocument();

    const { promise, resolve } = deferred<{ error?: string }>();
    deleteOrganization.mockReturnValue(promise);
    await user.click(screen.getByRole("button", { name: "Delete forever" }));

    expect(
      screen.queryByText("Could not delete the team. Please try again."),
    ).not.toBeInTheDocument();
    resolve({});
  });
});
