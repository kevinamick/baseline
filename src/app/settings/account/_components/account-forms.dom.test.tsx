// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
});
