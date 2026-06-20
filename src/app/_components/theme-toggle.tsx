"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { SunIcon, MoonIcon, MonitorIcon } from "./icons";
import type { ThemePref } from "@/types/theme";

const OPTIONS: {
  value: ThemePref;
  labelKey: "themeLight" | "themeSystem" | "themeDark";
  Icon: typeof SunIcon;
}[] = [
  { value: "light", labelKey: "themeLight", Icon: SunIcon },
  { value: "system", labelKey: "themeSystem", Icon: MonitorIcon },
  { value: "dark", labelKey: "themeDark", Icon: MoonIcon },
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
  const t = useTranslations("AppShell");

  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 text-[11px] text-fg-3">{t("theme")}</div>
      {/* Icon-only segments: three labels + icons don't fit the menu width, so
          the labels are screen-reader-only (with a title tooltip). Equal-radius
          pills nest cleanly, so no overflow clipping is needed. */}
      <div
        role="radiogroup"
        aria-label={t("theme")}
        className="flex items-center gap-0.5 rounded-full border border-hairline-cool bg-card-warm p-0.5"
      >
        {OPTIONS.map(({ value, labelKey, Icon }) => {
          const active = pref === value;
          const label = t(labelKey);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={label}
              title={label}
              onClick={() => window.BaselineTheme?.set(value)}
              className={`flex flex-1 items-center justify-center rounded-full py-1.5 transition-colors ${
                active ? "bg-ink text-fg-on-ink" : "text-fg-2 hover:text-fg-1"
              }`}
            >
              <Icon size={15} />
              <span className="sr-only">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
