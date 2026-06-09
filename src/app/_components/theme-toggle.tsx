"use client";

import { useSyncExternalStore } from "react";
import { SunIcon, MoonIcon } from "./icons";
import type { ResolvedTheme } from "@/types/theme";

// Subscribe to theme changes broadcast by the pre-paint script (also fired when
// the OS scheme changes while the preference is "system").
function subscribe(onChange: () => void) {
  document.addEventListener("baseline-theme-change", onChange);
  return () => document.removeEventListener("baseline-theme-change", onChange);
}
const getSnapshot = (): ResolvedTheme =>
  window.BaselineTheme?.resolved() ?? "light";
// The server can't know the resolved theme; default to light. useSyncExternalStore
// reconciles to the real client value on hydration without a mismatch warning.
const getServerSnapshot = (): ResolvedTheme => "light";

/**
 * Nav icon-button that flips light ↔ dark via window.BaselineTheme (exposed by
 * the pre-paint theme script). Shows the icon for the theme you'd switch *to*:
 * a moon in light, a sun in dark.
 */
export function ThemeToggle() {
  const resolved = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const isDark = resolved === "dark";
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      title="Toggle theme"
      aria-label={label}
      onClick={() => window.BaselineTheme?.toggle()}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline-cool bg-card text-ink transition-colors hover:bg-card-warm"
    >
      {isDark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </button>
  );
}
