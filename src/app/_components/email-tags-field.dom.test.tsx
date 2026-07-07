// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailTagsField, useEmailTags } from "./email-tags-field";

// EmailTagsField is a controlled chip input driven by the useEmailTags hook, so
// exercise the two together through a tiny harness — the same way the dialogs use it.
function Harness() {
  const tags = useEmailTags();
  return <EmailTagsField id="emails" tags={tags} />;
}

describe("EmailTagsField", () => {
  it("commits a typed address into a chip on Enter", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("textbox");
    await user.type(input, "alice@example.com{Enter}");

    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    // The draft is cleared once committed.
    expect(input).toHaveValue("");
  });

  it("commits on comma and on blur", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("textbox");
    await user.type(input, "bob@example.com,");
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();

    await user.type(input, "carol@example.com");
    await user.tab(); // blur
    expect(screen.getByText("carol@example.com")).toBeInTheDocument();
  });

  it("ignores invalid drafts and de-duplicates committed addresses", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("textbox");
    await user.type(input, "not-an-email{Enter}");
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    // Invalid draft stays in the box rather than being silently dropped.
    expect(input).toHaveValue("not-an-email");
    await user.clear(input);

    await user.type(input, "dave@example.com{Enter}");
    await user.type(input, "dave@example.com{Enter}");
    expect(screen.getAllByText("dave@example.com")).toHaveLength(1);
  });

  it("removes a chip via its Remove button", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("textbox");
    await user.type(input, "erin@example.com{Enter}");
    expect(screen.getByText("erin@example.com")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove erin@example.com" }));
    expect(screen.queryByText("erin@example.com")).not.toBeInTheDocument();
  });

  it("container has focus-within ring classes for keyboard accessibility", () => {
    render(<Harness />);
    // The wrapping div uses CSS focus-within to apply the same branded ring as
    // bare <input> elements when the internal text input is focused.
    const container = screen.getByRole("textbox").closest("div");
    expect(container?.className).toContain("focus-within:border-accent");
    expect(container?.className).toContain("focus-within:ring-[3px]");
    expect(container?.className).toContain("ring-accent");
  });

  it("shows the placeholder only while the list is empty", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByPlaceholderText("you@example.com, then Enter");
    await user.type(input, "frank@example.com{Enter}");

    // Once a chip exists the placeholder is dropped.
    expect(input).not.toHaveAttribute("placeholder", "you@example.com, then Enter");
    expect(
      within(screen.getByText("frank@example.com")).getByRole("button", {
        name: "Remove frank@example.com",
      }),
    ).toBeInTheDocument();
  });
});
