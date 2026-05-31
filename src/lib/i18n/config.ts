export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isValidLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
