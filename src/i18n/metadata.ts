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

/**
 * Like {@link buildAlternates}, but for a marketing page that exists in only the
 * locales it declares (ADR-0013) rather than the full tri-lingual set. At launch
 * a comparison/category page advertises `["en"]`: this returns a self-referencing
 * canonical and **no** `hreflang` cluster, because a single-locale `hreflang`
 * group is meaningless and a broken/incomplete one risks Google suppressing the
 * whole cluster. As soon as `es`/`fr` content lands (issue #280) the page widens
 * its locale set and this emits the full `hreflang` cluster for exactly that set.
 */
export function buildMarketingAlternates(
  locale: string,
  path: string,
  localeSet: readonly AppLocale[]
): NonNullable<Metadata["alternates"]> {
  // Fall back to the set's representative if asked for a locale it doesn't cover
  // (it shouldn't be — the page 404s first — but keep canonical well-defined).
  const current = localeSet.includes(locale as AppLocale)
    ? (locale as AppLocale)
    : (localeSet[0] ?? defaultLocale);
  const canonical = localizedPath(current, path);

  // Single-locale page: self-canonical only, no hreflang cluster.
  if (localeSet.length < 2) return { canonical };

  const languages: Record<string, string> = {};
  // x-default points at the default locale when the page exists there, else the
  // set's first locale, so x-default never references a non-existent page.
  const xDefault = localeSet.includes(defaultLocale) ? defaultLocale : localeSet[0];
  languages["x-default"] = localizedPath(xDefault, path);
  for (const l of localeSet) languages[l] = localizedPath(l, path);

  return { canonical, languages };
}
