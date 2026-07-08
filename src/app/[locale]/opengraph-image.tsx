import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";

// The landing page's OG card: the same dark-card template as the category/
// comparison/blog cards (category-og.tsx) so every social preview reads as one
// system. Without it the landing page had no og:image and unfurlers fell back
// to the favicon. The brand row renders the actual Baseline glyph (the
// favicon.svg bar mark) rather than an empty square — this is the flagship card.
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Baseline";

// The favicon.svg mark, redrawn as nested divs at 64px (satori renders no
// external images without embedding; the geometry is four bars on an ink tile).
function BaselineMark() {
  return (
    <div
      style={{
        width: "64px",
        height: "64px",
        borderRadius: "16px",
        background: "#0E0E10",
        border: "1px solid #262a33",
        display: "flex",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "12px",
          bottom: "13px",
          width: "40px",
          height: "3px",
          borderRadius: "1.5px",
          background: "#FAFAFA",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "16px",
          bottom: "16px",
          width: "6px",
          height: "12px",
          borderRadius: "1px",
          background: "#FAFAFA",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "29px",
          bottom: "16px",
          width: "6px",
          height: "20px",
          borderRadius: "1px",
          background: "#FAFAFA",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "42px",
          bottom: "16px",
          width: "6px",
          height: "32px",
          borderRadius: "1px",
          background: "#2B5BD7",
        }}
      />
    </div>
  );
}

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });

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
            gap: "20px",
            color: "#ffffff",
            fontSize: "40px",
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          <BaselineMark />
          {t("siteTitle")}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "64px",
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
            maxWidth: "980px",
          }}
        >
          {t("siteDescription")}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "30px",
            color: "#9ca3af",
            letterSpacing: "-0.01em",
          }}
        >
          baselinelab.ai
        </div>
      </div>
    ),
    { ...size }
  );
}
