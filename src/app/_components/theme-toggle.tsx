"use client";

import { useSyncExternalStore } from "react";
import { SunIcon, MoonIcon, MonitorIcon } from "./icons";
import type { ThemePref } from "@/types/theme";

const OPTIONS: { value: ThemePref; label: string; Icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

// Subscribe to theme changes broadcast by the pre-paint script (also fired when
// the OS scheme changes while the preference is "system").
function subscribe(onChange: () => void) {
  document.addEventListener("baseline-theme-change", onChange);
  return () => document.removeEventListener("baseline-theme-change", onChange);
}
const getSnapshot = (): ThemePref => window.BaselineTheme?.get() ?? "system";
// The server can't know the stored preference; default to "system".
// useSyncExternalStore reconciles to the real client value on hydration.
const getServerSnapshot = (): ThemePref => "system";

/**
 * Three-way Light / System / Dark control for the account menu. Reads and writes
 * the preference through window.BaselineTheme (exposed by the pre-paint script)
 * and stays in sync via the `baseline-theme-change` event, so an OS change under
 * "System" reflects here too.
 */
export function ThemeToggle() {
  const pref = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 text-[11px] text-fg-3">Theme</div>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="flex items-center gap-0.5 rounded-full border border-hairline-cool bg-card-warm p-0.5"
      >
        {OPTIONS.map(({ value, label, Icon }) => {
          const active = pref === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              title={label}
              onClick={() => window.BaselineTheme?.set(value)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                active ? "bg-ink text-fg-on-ink" : "text-fg-2 hover:text-fg-1"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
