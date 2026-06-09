// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { ThemeToggle } from "./theme-toggle";
import type { ThemePref } from "@/types/theme";

// A fake of the global the pre-paint script installs (see theme-script.tsx). The
// component reads `get()` and writes via `set()`; we drive the subscription by
// dispatching the same `baseline-theme-change` event the real script fires.
function installBaselineTheme(initial: ThemePref) {
  let pref = initial;
  const api = {
    get: vi.fn(() => pref),
    resolved: vi.fn(() => (pref === "dark" ? "dark" : "light")),
    set: vi.fn((p: ThemePref) => {
      pref = p;
      document.dispatchEvent(
        new CustomEvent("baseline-theme-change", {
          detail: { pref: p, resolved: p === "dark" ? "dark" : "light" },
        }),
      );
    }),
    toggle: vi.fn(),
  };
  window.BaselineTheme = api;
  // Simulate the preference changing from another surface/tab — the script
  // updates its value and broadcasts, which is what the component subscribes to.
  const emit = (p: ThemePref) => api.set(p);
  return { api, emit };
}

afterEach(() => {
  delete window.BaselineTheme;
});

describe("ThemeToggle", () => {
  it("renders Light / System / Dark radios with accessible names", () => {
    installBaselineTheme("system");
    render(<ThemeToggle />);

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group).toBeInTheDocument();
    for (const name of ["Light", "System", "Dark"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
  });

  it("marks the stored preference as checked", () => {
    installBaselineTheme("dark");
    render(<ThemeToggle />);

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "System" })).not.toBeChecked();
  });

  it("calls BaselineTheme.set with the chosen preference on click", async () => {
    const { api } = installBaselineTheme("system");
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(api.set).toHaveBeenCalledWith("dark");

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(api.set).toHaveBeenCalledWith("light");
  });

  it("reflects a preference changed elsewhere (subscription via the event)", () => {
    const { emit } = installBaselineTheme("light");
    render(<ThemeToggle />);
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();

    // Another surface/tab changes the preference; the script broadcasts it.
    act(() => emit("dark"));

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();
  });

  it("falls back to System when no theme global is present", () => {
    // No installBaselineTheme(): getSnapshot must not throw and defaults to system.
    render(<ThemeToggle />);
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  });
});
