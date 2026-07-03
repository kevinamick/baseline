// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./switch";

// Controlled toggle harness — mirrors how consumers wire Switch (checked state lives
// in the parent, onChange feeds it back).
function Harness({ initial = false, disabled }: { initial?: boolean; disabled?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return <Switch checked={checked} onChange={setChecked} disabled={disabled} label="Enable feature" />;
}

describe("Switch", () => {
  it("renders as an ARIA switch reflecting the checked state", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable feature" />);
    const el = screen.getByRole("switch", { name: "Enable feature" });
    expect(el).toHaveAttribute("aria-checked", "false");
  });

  it("reflects aria-checked=true when checked", () => {
    render(<Switch checked={true} onChange={vi.fn()} label="Enable feature" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("calls onChange with the negated value when clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Enable feature" />);

    await user.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("toggles back and forth when wired to controlled state", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const el = screen.getByRole("switch");
    expect(el).toHaveAttribute("aria-checked", "false");

    await user.click(el);
    expect(el).toHaveAttribute("aria-checked", "true");

    await user.click(el);
    expect(el).toHaveAttribute("aria-checked", "false");
  });

  it("is disabled and does not fire onChange when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} disabled label="Enable feature" />);

    const el = screen.getByRole("switch");
    expect(el).toBeDisabled();

    await user.click(el);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies the checked (on) track and thumb classes", () => {
    render(<Switch checked={true} onChange={vi.fn()} label="Enable feature" />);
    const el = screen.getByRole("switch");
    expect(el).toHaveClass("bg-ink");
    expect(el).not.toHaveClass("bg-hairline-strong");
    expect(el.firstElementChild).toHaveClass("translate-x-[22px]");
  });

  it("applies the unchecked (off) track and thumb classes", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable feature" />);
    const el = screen.getByRole("switch");
    expect(el).toHaveClass("bg-hairline-strong");
    expect(el).not.toHaveClass("bg-ink");
    expect(el.firstElementChild).toHaveClass("translate-x-0.5");
  });

  it("omits the accessible label when none is passed", () => {
    render(<Switch checked={false} onChange={vi.fn()} />);
    const el = screen.getByRole("switch");
    expect(el).not.toHaveAttribute("aria-label");
  });

  it("is a plain (non-submit) button so it never triggers a host form", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable feature" />);
    expect(screen.getByRole("switch")).toHaveAttribute("type", "button");
  });
});
