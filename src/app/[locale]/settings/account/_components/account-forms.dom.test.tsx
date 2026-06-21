// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";

// AccountForms reads the next-intl catalog via useTranslations, so renders need
// a provider wrapped around the English catalog (real ICU, not a stub).
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const { mockUpdateProfile, mockChangeEmail, mockChangePassword } = vi.hoisted(
  () => ({
    mockUpdateProfile: vi.fn(),
    mockChangeEmail: vi.fn(),
    mockChangePassword: vi.fn(),
  })
);
vi.mock("@/app/actions/account", () => ({
  updateProfile: mockUpdateProfile,
  changeEmail: mockChangeEmail,
  changePassword: mockChangePassword,
}));

import { AccountForms } from "./account-forms";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AccountForms", () => {
  it("prefills the display name and shows the current email", () => {
    render(<AccountForms displayName="Ada Lovelace" email="ada@b.com" />);

    const profile = screen.getByRole("form", { name: "Profile" });
    expect(within(profile).getByRole("textbox")).toHaveValue("Ada Lovelace");
    expect(
      within(screen.getByRole("form", { name: "Email" })).getByText("ada@b.com")
    ).toBeInTheDocument();
  });

  it("submits the profile form and surfaces the saved confirmation", async () => {
    const user = userEvent.setup();
    mockUpdateProfile.mockResolvedValue({ saved: true });
    render(<AccountForms displayName="" email="ada@b.com" />);

    const profile = screen.getByRole("form", { name: "Profile" });
    await user.type(within(profile).getByRole("textbox"), "Grace");
    await user.click(within(profile).getByRole("button", { name: "Save" }));

    expect(mockUpdateProfile).toHaveBeenCalledTimes(1);
    const submitted = mockUpdateProfile.mock.calls[0][1] as FormData;
    expect(submitted.get("name")).toBe("Grace");
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
  });

  it("renders the provider error returned by the change-email action", async () => {
    const user = userEvent.setup();
    mockChangeEmail.mockResolvedValue({ error: "already in use" });
    render(<AccountForms displayName="Ada" email="ada@b.com" />);

    const emailForm = screen.getByRole("form", { name: "Email" });
    await user.type(within(emailForm).getByRole("textbox"), "new@b.com");
    await user.click(
      within(emailForm).getByRole("button", { name: "Change email" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("already in use");
  });

  it("gates the password change behind an emailed code, then submits it as the nonce", async () => {
    const user = userEvent.setup();
    mockChangePassword
      .mockResolvedValueOnce({ codeSent: true })
      .mockResolvedValueOnce({ saved: true });
    render(<AccountForms displayName="Ada" email="ada@b.com" />);

    const pwForm = screen.getByRole("form", { name: "Password" }) as HTMLFormElement;
    const password = pwForm.querySelector("#password") as HTMLInputElement;
    const confirm = pwForm.querySelector("#confirmPassword") as HTMLInputElement;

    // No code field until a code has been requested.
    expect(
      within(pwForm).queryByPlaceholderText("6-digit code")
    ).not.toBeInTheDocument();

    await user.type(password, "secret1");
    await user.type(confirm, "secret1");
    await user.click(
      within(pwForm).getByRole("button", { name: "Send confirmation code" })
    );

    // First call is the send-code step.
    const first = mockChangePassword.mock.calls[0][1] as FormData;
    expect(first.get("intent")).toBe("send-code");

    // The code field now appears; supply the code and finish.
    const codeField = await within(pwForm).findByPlaceholderText("6-digit code");
    await user.type(codeField, "123456");
    await user.click(
      within(pwForm).getByRole("button", { name: "Update password" })
    );

    const second = mockChangePassword.mock.calls[1][1] as FormData;
    expect(second.get("intent")).toBe("submit");
    expect(second.get("code")).toBe("123456");
    expect(second.get("password")).toBe("secret1");
    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
  });
});
