import type { MetadataRoute } from "next";
import { locales, defaultLocale, type AppLocale } from "@/i18n/routing";
import { localizedPath } from "@/i18n/metadata";
import { absoluteUrl } from "@/lib/site-url";
import { COMPARISONS } from "@/lib/marketing/comparisons";
import { CATEGORIES } from "@/lib/marketing/categories";
import { POSTS } from "@/lib/marketing/posts";

// The tri-lingual funnel pages (ADR-0011): each exists in every locale, so each
// entry carries the full per-locale `hreflang` cluster (en/es/fr + x-default).
// Auth-utility pages (sign-in, sign-up, forgot/reset-password, invite) are
// deliberately absent — thin pages we don't advertise, noindexed in #275.
const PUBLIC_PATHS = ["/", "/pricing", "/privacy"] as const;

// One sitemap entry for `path`, carrying an `hreflang` cluster only when the page
// exists in more than one locale (ADR-0013) — a single-locale marketing page gets
// a bare self-canonical entry with no alternates, matching its in-page metadata.
function entry(
  path: string,
  localeSet: readonly AppLocale[],
  priority: number
): MetadataRoute.Sitemap[number] {
  const canonicalLocale = (localeSet as readonly string[]).includes(defaultLocale)
    ? defaultLocale
    : (localeSet[0] ?? defaultLocale);
  const base: MetadataRoute.Sitemap[number] = {
    url: absoluteUrl(localizedPath(canonicalLocale, path)),
    changeFrequency: "weekly",
    priority,
  };
  if (localeSet.length < 2) return base;

  const languages: Record<string, string> = {
    "x-default": absoluteUrl(localizedPath(defaultLocale, path)),
  };
  for (const locale of localeSet) {
    languages[locale] = absoluteUrl(localizedPath(locale, path));
  }
  return { ...base, alternates: { languages } };
}

export default function sitemap(): MetadataRoute.Sitemap {
  const funnel = PUBLIC_PATHS.map((path) =>
    entry(path, locales, path === "/" ? 1 : 0.8)
  );

  // Marketing/SEO pages register from their own locale set (ADR-0013); at launch
  // these are en-only, so they appear as bare en entries with no `hreflang`.
  const comparisons = COMPARISONS.map((c) =>
    entry(`/compare/${c.slug}`, c.locales, 0.7)
  );

  // Category landers target head terms — slightly higher priority than comparisons.
  const categories = CATEGORIES.map((c) => entry(`/${c.slug}`, c.locales, 0.8));

  // The /blog index is tri-lingual chrome (like the /docs hub) even though
  // today's only post is en-only (#435); each post registers from its own
  // locale set (ADR-0013), same as a category/comparison page.
  const blogIndex = [entry("/blog", locales, 0.6)];
  const posts = POSTS.map((p) => entry(`/blog/${p.slug}`, p.locales, 0.6));

  return [...funnel, ...comparisons, ...categories, ...blogIndex, ...posts];
}
