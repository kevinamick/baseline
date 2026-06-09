// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_SCRIPT } from "./theme-script";

// Run the actual shipped inline resolver (the string injected in <head>) in a
// jsdom document and assert the behavior the dark-mode feature relies on: it
// stamps [data-theme] before paint, exposes window.BaselineTheme, persists a
// choice, and only enables the cross-fade ([data-theme-animating]) on a change,
// never on first paint.

let mqListener: (() => void) | undefined;
// The script keeps a single `mq = matchMedia(...)` reference, so OS changes are
// simulated by mutating this captured object's `matches`, not by re-stubbing.
let mqObject: { matches: boolean } | undefined;

function runScript() {
  new Function(THEME_SCRIPT)();
}

function stubMatchMedia(prefersDark: boolean) {
  mqObject = {
    matches: prefersDark,
    addEventListener: (_: string, cb: () => void) => (mqListener = cb),
    addListener: (cb: () => void) => (mqListener = cb),
  } as { matches: boolean };
  window.matchMedia = vi
    .fn()
    .mockReturnValue(mqObject) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  mqListener = undefined;
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-pref");
  document.documentElement.removeAttribute("data-theme-animating");
});

afterEach(() => {
  delete window.BaselineTheme;
});

describe("theme resolver script", () => {
  it("defaults to the OS preference (system) and stamps the resolved theme", () => {
    stubMatchMedia(true); // OS prefers dark
    runScript();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "system",
    );
    expect(window.BaselineTheme?.get()).toBe("system");
    expect(window.BaselineTheme?.resolved()).toBe("dark");
  });

  it("honors a stored explicit choice over the OS preference", () => {
    localStorage.setItem("baseline-theme", "light");
    stubMatchMedia(true); // OS dark, but stored light wins
    runScript();

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.BaselineTheme?.get()).toBe("light");
  });

  it("does NOT animate on first paint (no flash / no cross-fade on load)", () => {
    stubMatchMedia(false);
    runScript();
    expect(
      document.documentElement.hasAttribute("data-theme-animating"),
    ).toBe(false);
  });

  it("set() persists the choice, flips the attribute, and enables the cross-fade", () => {
    stubMatchMedia(false);
    runScript();

    const changes: string[] = [];
    document.addEventListener("baseline-theme-change", (e) =>
      changes.push((e as CustomEvent).detail.resolved),
    );

    window.BaselineTheme?.set("dark");

    expect(localStorage.getItem("baseline-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "dark",
    );
    // The animating gate is on right after an explicit change (CSS keys off it).
    expect(
      document.documentElement.hasAttribute("data-theme-animating"),
    ).toBe(true);
    expect(changes).toEqual(["dark"]);
  });

  it("set('system') clears the stored choice and follows the OS again", () => {
    stubMatchMedia(false); // OS light
    runScript();
    window.BaselineTheme?.set("dark");
    expect(localStorage.getItem("baseline-theme")).toBe("dark");

    window.BaselineTheme?.set("system");
    expect(localStorage.getItem("baseline-theme")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggle() flips the resolved theme to an explicit opposite", () => {
    stubMatchMedia(false); // resolves light
    runScript();

    window.BaselineTheme?.toggle();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.BaselineTheme?.get()).toBe("dark");
  });

  it("tracks the OS scheme while the preference is still system", () => {
    stubMatchMedia(false); // OS light initially
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Simulate the OS flipping to dark; the script re-resolves under "system".
    mqObject!.matches = true;
    mqListener?.();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
