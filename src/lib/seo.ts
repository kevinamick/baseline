import type { Metadata } from "next";
import { locales, defaultLocale, type AppLocale } from "@/i18n/routing";
import { localizedPath } from "@/i18n/metadata";

/**
 * Metadata fragment that keeps a page out of the search index while still letting
 * crawlers follow its links. Assigned to thin auth-utility pages (sign-in,
 * sign-up, forgot/reset-password, invite) so they don't dilute the indexable
 * surface or compete for brand terms.
 */
export const noindex: Metadata = {
  robots: { index: false, follow: true },
};

// Open Graph wants `language_TERRITORY`; map our app locales (everything else
// falls back to the default locale's form).
const OG_LOCALE: Record<AppLocale, string> = {
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
};

function asLocale(locale: string): AppLocale {
  return (locales as readonly string[]).includes(locale)
    ? (locale as AppLocale)
    : defaultLocale;
}

/**
 * Default Open Graph block for the page at `path` in `locale`. `url` is the
 * localized canonical path, resolved to an absolute URL against `metadataBase`.
 * Pages may override per-page. No `og:image` is emitted yet — one will be
 * supplied site-wide once the `opengraph-image` route lands with the marketing
 * surface (#276).
 */
export function defaultOpenGraph(
  locale: string,
  path: string,
  title: string,
  description: string
): NonNullable<Metadata["openGraph"]> {
  const current = asLocale(locale);
  return {
    type: "website",
    siteName: "Baseline",
    title,
    description,
    url: localizedPath(current, path),
    locale: OG_LOCALE[current],
  };
}

/** Default Twitter card block (large-image summary). */
export function defaultTwitter(
  title: string,
  description: string
): NonNullable<Metadata["twitter"]> {
  return {
    card: "summary_large_image",
    title,
    description,
  };
}

/**
 * Google Search Console verification, emitted only when the token env is set so
 * the meta tag is absent in environments that haven't been verified.
 */
export function googleVerification(): Metadata["verification"] | undefined {
  const token = process.env.GOOGLE_SITE_VERIFICATION;
  return token ? { google: token } : undefined;
}
