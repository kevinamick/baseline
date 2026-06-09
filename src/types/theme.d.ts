// Theme preference / resolved values exposed by the pre-paint theme script
// (see src/app/_components/theme-script.tsx).
export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

declare global {
  interface Window {
    BaselineTheme?: {
      get(): ThemePref;
      resolved(): ResolvedTheme;
      set(pref: ThemePref): void;
      toggle(): void;
    };
  }

  interface DocumentEventMap {
    "baseline-theme-change": CustomEvent<{
      pref: ThemePref;
      resolved: ResolvedTheme;
    }>;
  }
}

export {};
