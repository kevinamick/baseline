import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { AppLocale } from "@/i18n/routing";
import {
  comparisonStaticParams,
  getComparison,
} from "@/lib/marketing/comparisons";

// Mirror the page so the OG image prerenders for exactly the same locale/slug set
// (ADR-0013): en-only at launch, unknown combos 404.
export const dynamicParams = false;
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Baseline comparison";

export function generateStaticParams({
  params,
}: {
  params: { locale: string };
}): { competitor: string }[] {
  return comparisonStaticParams(params.locale);
}

/**
 * Dynamic OpenGraph image for a comparison page — renders the page's title and
 * brand into a 1200×630 PNG at build time, so every competitor page gets a social
 * card without a hand-made asset (the reuse this tracer proves). Next wires the
 * output into the page's `<head>` as `og:image` automatically.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; competitor: string }>;
}) {
  const { locale, competitor } = await params;
  const comparison = getComparison(competitor);
  // Mirror the page's guard exactly: 404 outside the comparison's locale set, so
  // the image never renders for a locale the page itself doesn't serve.
  if (!comparison || !comparison.locales.includes(locale as AppLocale)) {
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
            fontSize: "84px",
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
          }}
        >
          {`Baseline vs ${comparison.competitor}`}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "34px",
            color: "#9ca3af",
            letterSpacing: "-0.01em",
          }}
        >
          LLM evaluation, compared
        </div>
      </div>
    ),
    { ...size }
  );
}
