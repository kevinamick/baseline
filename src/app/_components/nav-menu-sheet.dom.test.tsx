// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavMenuSheet, navSheetItem } from "./nav-menu-sheet";

// jsdom ships no matchMedia; the sheet uses it for the breakpoint auto-close.
// Stub a never-matching query so the listener wiring runs without throwing.
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  // Each test re-locks document scroll; make sure it never leaks between tests.
  document.body.style.overflow = "";
});

function Harness() {
  return (
    <NavMenuSheet label="Menu">
      {(close) => (
        <button type="button" className={navSheetItem} onClick={close}>
          Dashboard
        </button>
      )}
    </NavMenuSheet>
  );
}

describe("NavMenuSheet", () => {
  it("is closed initially and opens the panel on trigger click", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Menu" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("locks body scroll while open and restores it on close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Menu" });

    await user.click(trigger);
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Menu" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes when a sheet item invokes the passed close()", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Menu" });

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Dashboard" }));

    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
