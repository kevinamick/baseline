import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { AppLocale } from "@/i18n/routing";
import { getCategory } from "@/lib/marketing/categories";

// Shared OG card config + renderer for the category landers (#278). Each route's
// opengraph-image.tsx re-exports these constants and defers its default handler here,
// so the social card lives in one place — the reuse the marketing infra is built for.
export const categoryOgContentType = "image/png";
export const categoryOgSize = { width: 1200, height: 630 };
export const categoryOgAlt = "Baseline";

/**
 * Dynamic OpenGraph image for a category page — renders the page's heading and
 * brand into a 1200×630 PNG on request. Mirrors the page's locale-set guard exactly
 * (404 outside the category's locales), so the image never renders for a locale the
 * page itself doesn't serve. Next wires the output into `<head>` as `og:image`.
 */
export async function renderCategoryOgImage(
  slug: string,
  params: Promise<{ locale: string }>
) {
  const { locale } = await params;
  // Resolve into the request locale (#280) so the card shows the localized heading
  // and subtitle, then mirror the page's locale-set guard exactly.
  const category = getCategory(slug, locale as AppLocale);
  if (!category || !category.locales.includes(locale as AppLocale)) {
    notFound();
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0f17",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            color: "#9ca3af",
            fontSize: "30px",
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: "#2563eb",
            }}
          />
          Baseline
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "66px",
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
          }}
        >
          {category.heading}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "32px",
            color: "#9ca3af",
            letterSpacing: "-0.01em",
          }}
        >
          {category.ogSubtitle}
        </div>
      </div>
    ),
    { ...categoryOgSize }
  );
}
