import type { MetadataRoute } from "next";
import { locales, defaultLocale } from "@/i18n/routing";
import { localizedPath } from "@/i18n/metadata";
import { absoluteUrl } from "@/lib/site-url";

// The public, indexable marketing surface. These are the tri-lingual funnel pages
// (ADR-0011), so each entry carries per-locale `hreflang` alternates (en/es/fr +
// x-default). Auth-utility pages (sign-in, sign-up, forgot/reset-password, invite)
// are deliberately absent — they're marked noindex, not advertised here. New
// marketing/SEO pages (ADR-0013) will register here from their own locale set.
const PUBLIC_PATHS = ["/", "/pricing", "/privacy"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => {
    const languages: Record<string, string> = {
      "x-default": absoluteUrl(localizedPath(defaultLocale, path)),
    };
    for (const locale of locales) {
      languages[locale] = absoluteUrl(localizedPath(locale, path));
    }

    return {
      // Canonical loc is the default-locale (unprefixed) URL; the alternates
      // mirror the self-canonical + hreflang that `buildAlternates` emits in-page.
      url: absoluteUrl(localizedPath(defaultLocale, path)),
      changeFrequency: "weekly",
      priority: path === "/" ? 1 : 0.8,
      alternates: { languages },
    };
  });
}
