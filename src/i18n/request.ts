import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Resolves the per-request locale (from the `[locale]` segment the middleware
// matched) and loads its catalog. An unknown/missing segment falls back to the
// default locale. Missing *keys* within a catalog fall back to English at render
// time via next-intl's own fallback — see ADR-0011's catalog discipline.
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
