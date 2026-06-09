// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTooltip } from "./info-tooltip";

describe("InfoTooltip", () => {
  it("renders the info button", () => {
    render(<InfoTooltip content="Helpful hint" />);
    expect(screen.getByRole("button", { name: "More information" })).toBeInTheDocument();
  });

  it("does not show tooltip content by default", () => {
    render(<InfoTooltip content="Helpful hint" />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows tooltip on mouse enter and hides on mouse leave", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Hover content" />);

    const btn = screen.getByRole("button", { name: "More information" });
    await user.hover(btn);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hover content");

    await user.unhover(btn);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows tooltip on focus and hides on blur", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Focus content" />);

    const btn = screen.getByRole("button", { name: "More information" });
    await user.tab(); // focus the button
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Focus content");

    await user.tab(); // blur
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("sets aria-describedby on button when tooltip is open", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Aria check" />);

    const btn = screen.getByRole("button", { name: "More information" });
    expect(btn).not.toHaveAttribute("aria-describedby");

    await user.hover(btn);
    expect(btn).toHaveAttribute("aria-describedby");
    const tooltipId = btn.getAttribute("aria-describedby")!;
    expect(document.getElementById(tooltipId)).toBeInTheDocument();
  });
});
