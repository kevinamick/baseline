import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";

// The /blog index OG card (#435): mirrors the category/comparison cards'
// dark-card template (category-og.tsx) so every marketing surface's social
// preview reads as one system, but renders the static index heading/subtitle
// rather than a per-slug lookup.
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Baseline blog";

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Marketing.blog" });

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
            fontSize: "84px",
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
          }}
        >
          {t("heading")}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "32px",
            color: "#9ca3af",
            letterSpacing: "-0.01em",
          }}
        >
          {t("subtitle")}
        </div>
      </div>
    ),
    { ...size }
  );
}
