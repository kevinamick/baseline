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

// Real content dates for the funnel pages, emitted as `lastmod` — the one
// recrawl hint Google reads (`changefreq`/`priority` are ignored). Bump the
// entry when a page's copy materially changes; never stamp a build timestamp,
// an always-fresh fabricated date just teaches crawlers to ignore it.
// Marketing pages carry their own `updatedAt` in their data records instead.
const FUNNEL_UPDATED: Record<(typeof PUBLIC_PATHS)[number], string> = {
  "/": "2026-07-06",
  "/pricing": "2026-07-07",
  "/privacy": "2026-07-07",
};

// The /docs resources hub (#306): tri-lingual chrome like /blog, so it carries
// the full cluster; dated by its last content change.
const DOCS_UPDATED = "2026-06-21";

// One sitemap entry for `path`, carrying an `hreflang` cluster only when the page
// exists in more than one locale (ADR-0013) — a single-locale marketing page gets
// a bare self-canonical entry with no alternates, matching its in-page metadata.
function entry(
  path: string,
  localeSet: readonly AppLocale[],
  priority: number,
  lastModified: string
): MetadataRoute.Sitemap[number] {
  const canonicalLocale = (localeSet as readonly string[]).includes(defaultLocale)
    ? defaultLocale
    : (localeSet[0] ?? defaultLocale);
  const base: MetadataRoute.Sitemap[number] = {
    url: absoluteUrl(localizedPath(canonicalLocale, path)),
    lastModified,
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
    entry(path, locales, path === "/" ? 1 : 0.8, FUNNEL_UPDATED[path])
  );

  // Marketing/SEO pages register from their own locale set (ADR-0013); at launch
  // these are en-only, so they appear as bare en entries with no `hreflang`.
  const comparisons = COMPARISONS.map((c) =>
    entry(`/compare/${c.slug}`, c.locales, 0.7, c.updatedAt)
  );

  // Category landers target head terms — slightly higher priority than comparisons.
  const categories = CATEGORIES.map((c) =>
    entry(`/${c.slug}`, c.locales, 0.8, c.updatedAt)
  );

  // The resource hubs are tri-lingual chrome; /blog's `lastmod` is the newest
  // post date, since a new post is exactly what changes the index.
  const docs = [entry("/docs", locales, 0.6, DOCS_UPDATED)];
  const latestPost = POSTS.reduce(
    (max, p) => (p.publishedAt > max ? p.publishedAt : max),
    DOCS_UPDATED
  );
  const blogIndex = [entry("/blog", locales, 0.6, latestPost)];
  // Each post registers from its own locale set (ADR-0013), dated by its
  // `publishedAt` (there's no separate "updated" concept for posts yet, #435).
  const posts = POSTS.map((p) =>
    entry(`/blog/${p.slug}`, p.locales, 0.6, p.publishedAt)
  );

  return [
    ...funnel,
    ...comparisons,
    ...categories,
    ...docs,
    ...blogIndex,
    ...posts,
  ];
}
