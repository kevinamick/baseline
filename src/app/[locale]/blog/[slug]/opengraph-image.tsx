import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { AppLocale } from "@/i18n/routing";
import { getPost } from "@/lib/marketing/posts";

// Mirrors compare/[competitor]/opengraph-image.tsx: rendered on demand, no
// generateStaticParams/dynamicParams (the dynamic nonce-reading root layout
// forces a failing SSG attempt otherwise — see page.tsx). The locale-set guard
// keeps the image to the same locale/slug set as the page.
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Baseline";

/**
 * Dynamic OpenGraph image for a `/blog/{slug}` post — renders the post's
 * heading and OG subtitle into a 1200×630 PNG on request, the same dark-card
 * template every other marketing route's card uses (category-og.tsx).
 */
export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const post = getPost(slug);
  if (!post || !post.locales.includes(locale as AppLocale)) {
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
            fontSize: "58px",
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
          }}
        >
          {post.heading}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "32px",
            color: "#9ca3af",
            letterSpacing: "-0.01em",
          }}
        >
          {post.ogSubtitle}
        </div>
      </div>
    ),
    { ...size }
  );
}
