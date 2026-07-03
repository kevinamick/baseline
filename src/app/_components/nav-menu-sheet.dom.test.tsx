// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

// Two focusable rows — needed to exercise the Tab-trap wrap-around branches,
// which a single-item panel can't distinguish (first === last).
function TwoItemHarness({ closeAbovePx }: { closeAbovePx?: number }) {
  return (
    <NavMenuSheet label="Menu" closeAbovePx={closeAbovePx}>
      {(close) => (
        <>
          <button type="button" className={navSheetItem} onClick={close}>
            First
          </button>
          <button type="button" className={navSheetItem} onClick={close}>
            Second
          </button>
        </>
      )}
    </NavMenuSheet>
  );
}

// No focusable descendants — exercises the `items.length === 0` early return
// in the Tab trap.
function NoFocusableHarness() {
  return <NavMenuSheet label="Menu">{() => <p>Nothing to focus</p>}</NavMenuSheet>;
}

// Three rows — needed so a "middle" row (neither first nor last) exists, to
// exercise the Tab-trap's final no-op branch (focus already inside the
// panel, not at an edge, so neither wrap-around condition applies).
function ThreeItemHarness() {
  return (
    <NavMenuSheet label="Menu">
      {(close) => (
        <>
          <button type="button" className={navSheetItem} onClick={close}>
            First
          </button>
          <button type="button" className={navSheetItem} onClick={close}>
            Middle
          </button>
          <button type="button" className={navSheetItem} onClick={close}>
            Last
          </button>
        </>
      )}
    </NavMenuSheet>
  );
}

// A matchMedia stub whose "change" listener can be invoked on demand, so a
// test can simulate the viewport crossing the auto-close breakpoint without a
// real resize. Captures the query string it was constructed with too, so a
// test can assert `closeAbovePx` is threaded through correctly.
function createControllableMatchMedia() {
  let changeListener: (() => void) | null = null;
  let lastQuery = "";
  const mql = {
    matches: false,
    media: "",
    onchange: null,
    addEventListener: (event: string, cb: () => void) => {
      if (event === "change") changeListener = cb;
    },
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  const matchMedia = (query: string) => {
    lastQuery = query;
    mql.media = query;
    return mql;
  };
  return {
    matchMedia,
    trigger(matches: boolean) {
      mql.matches = matches;
      changeListener?.();
    },
    get lastQuery() {
      return lastQuery;
    },
  };
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

  it("toggles closed when the trigger is clicked again while open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Menu" });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
  });

  it("closes when the scrim (outside tap) is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Menu" });

    await user.click(trigger);
    const scrim = container.querySelector('[aria-hidden="true"]');
    expect(scrim).not.toBeNull();

    await user.click(scrim as Element);

    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("NavMenuSheet Tab trap", () => {
  it("wraps Tab from the last focusable row back to the first", async () => {
    const user = userEvent.setup();
    render(<TwoItemHarness />);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    second.focus();
    expect(second).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(first).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable row to the last", async () => {
    const user = userEvent.setup();
    render(<TwoItemHarness />);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    first.focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(second).toHaveFocus();
  });

  it("pulls focus into the panel (first row) on Tab when focus is outside it", async () => {
    const user = userEvent.setup();
    render(<TwoItemHarness />);

    const trigger = screen.getByRole("button", { name: "Menu" });
    await user.click(trigger);
    const first = screen.getByRole("button", { name: "First" });

    // The trigger sits outside panelRef, so it counts as "focus outside the panel".
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(first).toHaveFocus();
  });

  it("pulls focus into the panel (last row) on Shift+Tab when focus is outside it", async () => {
    const user = userEvent.setup();
    render(<TwoItemHarness />);

    const trigger = screen.getByRole("button", { name: "Menu" });
    await user.click(trigger);
    const second = screen.getByRole("button", { name: "Second" });

    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(second).toHaveFocus();
  });

  it("no-ops on Tab when the panel has no focusable descendants", async () => {
    const user = userEvent.setup();
    render(<NoFocusableHarness />);

    const trigger = screen.getByRole("button", { name: "Menu" });
    await user.click(trigger);
    expect(screen.getByText("Nothing to focus")).toBeInTheDocument();

    // Should not throw, and the sheet stays open since Tab isn't handled.
    expect(() => fireEvent.keyDown(document, { key: "Tab" })).not.toThrow();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves focus alone when Tab is pressed on a middle row", async () => {
    const user = userEvent.setup();
    render(<ThreeItemHarness />);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    const middle = screen.getByRole("button", { name: "Middle" });

    middle.focus();
    expect(middle).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(middle).toHaveFocus();
  });

  it("ignores non-Tab, non-Escape keys", async () => {
    const user = userEvent.setup();
    render(<TwoItemHarness />);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(() => fireEvent.keyDown(document, { key: "a" })).not.toThrow();
    expect(screen.getByRole("button", { name: "First" })).toBeInTheDocument();
  });
});

describe("NavMenuSheet breakpoint auto-close", () => {
  it("closes the sheet when the viewport crosses the min-width breakpoint", async () => {
    const { matchMedia, trigger } = createControllableMatchMedia();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: matchMedia,
    });

    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();

    act(() => trigger(true));

    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
  });

  it("stays open when the media-query change fires without a match", async () => {
    const { matchMedia, trigger } = createControllableMatchMedia();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: matchMedia,
    });

    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Menu" }));

    act(() => trigger(false));

    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("builds the media query from a custom closeAbovePx", async () => {
    const controller = createControllableMatchMedia();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: controller.matchMedia,
    });

    const user = userEvent.setup();
    render(<TwoItemHarness closeAbovePx={500} />);
    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(controller.lastQuery).toBe("(min-width: 500px)");
  });
});
