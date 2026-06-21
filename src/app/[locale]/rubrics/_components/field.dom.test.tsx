// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { Field } from "./field";
import enMessages from "../../../../../messages/en.json";

// Field reads the "· optional" marker from the Rubrics catalog, so render it
// under the real next-intl provider with the English messages.
function renderField(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe("Field", () => {
  it("renders the label text", () => {
    renderField(
      <Field label="My field" htmlFor="my-input">
        <input id="my-input" />
      </Field>
    );
    expect(screen.getByText("My field")).toBeInTheDocument();
  });

  it("renders the optional marker when optional=true", () => {
    renderField(
      <Field label="Optional field" optional>
        <input />
      </Field>
    );
    expect(screen.getByText("· optional")).toBeInTheDocument();
  });

  it("renders an error message when error is provided", () => {
    renderField(
      <Field label="Field" error="Something went wrong">
        <input />
      </Field>
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders the first error when error is an array", () => {
    renderField(
      <Field label="Field" error={["First error", "Second error"]}>
        <input />
      </Field>
    );
    expect(screen.getByText("First error")).toBeInTheDocument();
    expect(screen.queryByText("Second error")).not.toBeInTheDocument();
  });

  it("renders no info button when tooltip is not provided", () => {
    renderField(
      <Field label="No tooltip">
        <input />
      </Field>
    );
    expect(screen.queryByRole("button", { name: "More information" })).not.toBeInTheDocument();
  });

  it("renders an info button when tooltip is provided", () => {
    renderField(
      <Field label="With tooltip" tooltip="Some explanation">
        <input />
      </Field>
    );
    expect(screen.getByRole("button", { name: "More information" })).toBeInTheDocument();
  });

  it("shows tooltip content when the info button is hovered", async () => {
    const user = userEvent.setup();
    renderField(
      <Field label="Hover me" tooltip="Tooltip text here">
        <input />
      </Field>
    );

    const btn = screen.getByRole("button", { name: "More information" });
    await user.hover(btn);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tooltip text here");
  });

  it("associates the label with the input via htmlFor", () => {
    renderField(
      <Field label="Named field" htmlFor="named-input">
        <input id="named-input" />
      </Field>
    );
    const label = screen.getByText("Named field");
    expect(label.closest("label")).toHaveAttribute("for", "named-input");
  });
});
