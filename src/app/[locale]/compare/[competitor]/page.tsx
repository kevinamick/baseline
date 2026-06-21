import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import { defaultOpenGraph, defaultTwitter } from "@/lib/seo";
import {
  comparisonStaticParams,
  getComparison,
} from "@/lib/marketing/comparisons";
import { BrandMark } from "@/app/_components/brand-mark";
import { ComparisonContent } from "@/app/_components/comparison-content";
import { SiteFooter } from "@/app/_components/site-footer";

// ADR-0013 enforcement lives in the `notFound()` guard below, NOT in
// `dynamicParams`. The root layout reads headers() for the CSP nonce, so this
// whole route tree renders dynamically and nothing is prerendered — pairing that
// with `dynamicParams = false` made the allowed-params set empty and 404'd every
// compare URL. We let params render on demand and 404 anything outside a
// comparison's locale set (or an unknown slug) in the guard, which is the real,
// render-mode-independent guarantee that `/es|fr/compare/...` stay uncrawlable.
export function generateStaticParams({
  params,
}: {
  params: { locale: string };
}): { competitor: string }[] {
  return comparisonStaticParams(params.locale);
}

type CompareParams = { locale: string; competitor: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<CompareParams>;
}): Promise<Metadata> {
  const { locale, competitor } = await params;
  const comparison = getComparison(competitor);
  // Guard here too (not just generateStaticParams): a marketing page exists only
  // in its declared locale set, so a request outside it must 404, never serve.
  if (!comparison || !comparison.locales.includes(locale as AppLocale)) {
    notFound();
  }

  const path = `/compare/${comparison.slug}`;
  return {
    title: comparison.metaTitle,
    description: comparison.metaDescription,
    alternates: buildMarketingAlternates(locale, path, comparison.locales),
    // No og:image here — the colocated opengraph-image route supplies it.
    openGraph: defaultOpenGraph(
      locale,
      path,
      comparison.metaTitle,
      comparison.metaDescription
    ),
    twitter: defaultTwitter(comparison.metaTitle, comparison.metaDescription),
  };
}

export default async function ComparePage({
  params,
}: {
  params: Promise<CompareParams>;
}) {
  const { locale, competitor } = await params;
  const comparison = getComparison(competitor);
  if (!comparison || !comparison.locales.includes(locale as AppLocale)) {
    notFound();
  }

  const t = await getTranslations("Nav");

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex items-center gap-3 px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink"
        >
          <BrandMark size={20} />
          Baseline
        </Link>
        <div className="flex-1" />
        <Link
          href="/pricing"
          className="rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink"
        >
          {t("pricing")}
        </Link>
        <Link
          href="/sign-up"
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
        >
          {t("getStartedFree")}
        </Link>
      </header>

      <main className="flex flex-1 flex-col">
        <ComparisonContent comparison={comparison} />
      </main>

      <SiteFooter />
    </div>
  );
}
