import type { Metadata } from "next";
import { locales, defaultLocale, type AppLocale } from "./routing";

/**
 * The URL path for `path` under `locale`, honoring `localePrefix: 'as-needed'`:
 * the default locale stays unprefixed (`/pricing`), others are prefixed
 * (`/es/pricing`). `path` is the canonical, unprefixed route (`/`, `/pricing`).
 */
export function localizedPath(locale: AppLocale, path: string): string {
  if (locale === defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}

/**
 * Builds the `alternates` block for a localized page: a self-referencing
 * canonical plus `hreflang` alternates for every locale (and `x-default` →
 * the default locale). This is what keeps the auto-detect redirect (ADR-0011)
 * SEO-safe. Resolved against `metadataBase` set on the layout.
 */
export function buildAlternates(
  locale: string,
  path: string
): NonNullable<Metadata["alternates"]> {
  const current = (
    locales.includes(locale as AppLocale) ? locale : defaultLocale
  ) as AppLocale;

  const languages: Record<string, string> = {
    "x-default": localizedPath(defaultLocale, path),
  };
  for (const l of locales) languages[l] = localizedPath(l, path);

  return { canonical: localizedPath(current, path), languages };
}
