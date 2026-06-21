import type { MetadataRoute } from "next";
import { locales } from "@/i18n/routing";
import { localizedPath } from "@/i18n/metadata";
import { absoluteUrl } from "@/lib/site-url";

// Auth-gated app areas — these mirror the non-public surface guarded in proxy.ts
// (everything not in PUBLIC_ROUTES needs a session). Crawlers are redirected to
// sign-in anyway; disallowing them here is belt-and-suspenders and keeps them out
// of the index. Listed for every locale prefix since these routes are localized
// (`/dashboard`, `/es/dashboard`, `/fr/dashboard`, …).
const PROTECTED_AREAS = [
  "/dashboard",
  "/settings",
  "/rubrics",
  "/schedules",
  "/optimizations",
  "/onboarding",
];

export default function robots(): MetadataRoute.Robots {
  const disallow = [
    // Non-localized handlers with no crawl value.
    "/api/",
    "/auth/",
    "/ingest/",
    // Localized auth-gated areas, one entry per locale prefix.
    ...PROTECTED_AREAS.flatMap((path) =>
      locales.map((locale) => localizedPath(locale, path))
    ),
  ];

  return {
    rules: { userAgent: "*", allow: "/", disallow },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
