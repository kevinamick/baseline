// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";

// AccountDataRights reads the next-intl catalog via useTranslations, so renders
// need a provider wrapped around the English catalog.
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const { mockDeleteAccount, mockExportAccountData } = vi.hoisted(() => ({
  mockDeleteAccount: vi.fn(async () => ({})),
  mockExportAccountData: vi.fn(async () => ({})),
}));

vi.mock("@/app/actions/data-rights", () => ({
  deleteAccount: mockDeleteAccount,
  exportAccountData: mockExportAccountData,
}));

import { AccountDataRights } from "./account-data-rights";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AccountDataRights — delete confirmation gate", () => {
  it("keeps the delete button disabled until the typed email matches", async () => {
    render(<AccountDataRights email="ada@acme.com" />);
    const button = screen.getByRole("button", { name: /delete my account/i });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/to confirm/i), "ada@acme.com");
    expect(button).toBeEnabled();
  });

  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    render(<AccountDataRights email="ada@acme.com" />);
    const input = screen.getByLabelText(/to confirm/i);
    await userEvent.type(input, "  ADA@Acme.com  ");
    expect(screen.getByRole("button", { name: /delete my account/i })).toBeEnabled();
  });

  it("does not enable deletion on a wrong email", async () => {
    render(<AccountDataRights email="ada@acme.com" />);
    await userEvent.type(screen.getByLabelText(/to confirm/i), "bob@acme.com");
    expect(screen.getByRole("button", { name: /delete my account/i })).toBeDisabled();
  });
});

describe("AccountDataRights — export", () => {
  it("calls the export action when Download is clicked", async () => {
    mockExportAccountData.mockResolvedValueOnce({ error: "nope" });
    render(<AccountDataRights email="ada@acme.com" />);
    await userEvent.click(screen.getByRole("button", { name: /download my data/i }));
    expect(mockExportAccountData).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});
