import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import { defaultOpenGraph, defaultTwitter } from "@/lib/seo";
import { getComparison } from "@/lib/marketing/comparisons";
import { formatVerifiedDate } from "@/lib/marketing/format-date";
import { BrandMark } from "@/app/_components/brand-mark";
import { ComparisonContent } from "@/app/_components/comparison-content";
import { SiteFooter } from "@/app/_components/site-footer";

// Render on demand (SSR), like the rest of the app. The root layout reads
// headers() for the per-request CSP nonce, so a leaf page that doesn't itself
// touch a dynamic API gets statically rendered and then throws DYNAMIC_SERVER_USAGE
// when the layout/getTranslations read request state. Every other page sidesteps
// this implicitly by calling getAuthContext() (cookies); this page touches no
// auth, so it opts into dynamic rendering explicitly. (NO generateStaticParams /
// dynamicParams: with the dynamic layout those forced a failing SSG attempt.)
// ADR-0013's "en-only; /es|fr/compare/* and unknown slugs are uncrawlable"
// guarantee lives entirely in the `notFound()` guard below.
export const dynamic = "force-dynamic";

type CompareParams = { locale: string; competitor: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<CompareParams>;
}): Promise<Metadata> {
  const { locale, competitor } = await params;
  const comparison = getComparison(competitor, locale as AppLocale);
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
  const comparison = getComparison(competitor, locale as AppLocale);
  if (!comparison || !comparison.locales.includes(locale as AppLocale)) {
    notFound();
  }

  const t = await getTranslations("Nav");
  // Localized chrome (#280); the prose is already in `comparison`. `sideBySide`
  // interpolates the competitor name and the date is formatted for the locale.
  const tCmp = await getTranslations("Marketing.comparison");
  const labels = {
    whyHeading: tCmp("whyHeading"),
    sideBySide: tCmp("sideBySide", { competitor: comparison.competitor }),
    colDimension: tCmp("colDimension"),
    colBaseline: tCmp("colBaseline"),
    verifiedPrefix: tCmp("verifiedPrefix"),
    verifiedOn: formatVerifiedDate(comparison.asOf, locale as AppLocale),
    correctionPrompt: tCmp("correctionPrompt"),
    correctionCta: tCmp("correctionCta"),
    sourcesLabel: tCmp("sourcesLabel"),
  };

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
        <ComparisonContent comparison={comparison} labels={labels} />
      </main>

      <SiteFooter />
    </div>
  );
}
