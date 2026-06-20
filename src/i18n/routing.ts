import { defineRouting } from "next-intl/routing";

// Single source of truth for supported locales (single-source-enums convention).
// `en` is the source language and renders unprefixed (`/pricing`); every other
// locale is prefixed (`/es/pricing`) via `localePrefix: 'as-needed'`.
// Adding a locale here (plus its `messages/<locale>.json`) is, by design, all the
// wiring routing/switcher/hreflang need — see ADR-0011 and issue #242.
export const locales = ["en", "es", "fr"] as const;
export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "en";

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
});
