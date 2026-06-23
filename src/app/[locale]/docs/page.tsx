import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import { CATEGORIES, getCategory } from "@/lib/marketing/categories";
import { COMPARISONS, getComparison } from "@/lib/marketing/comparisons";
import { BrandMark } from "@/app/_components/brand-mark";
import { SiteFooter } from "@/app/_components/site-footer";

export const dynamic = "force-dynamic";

const SUPPORTED_LOCALES = ["en", "es", "fr"] as const satisfies readonly AppLocale[];

type Params = { locale: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!SUPPORTED_LOCALES.includes(locale as AppLocale)) notFound();
  const t = await getTranslations({ locale, namespace: "Marketing.docs" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: buildMarketingAlternates(locale, "/docs", SUPPORTED_LOCALES),
  };
}

export default async function DocsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { locale } = await params;
  if (!SUPPORTED_LOCALES.includes(locale as AppLocale)) notFound();

  const tNav = await getTranslations({ locale, namespace: "Nav" });
  const t = await getTranslations({ locale, namespace: "Marketing.docs" });

  const guides = CATEGORIES.filter((c) => c.locales.includes(locale as AppLocale)).map(
    (c) => getCategory(c.slug, locale as AppLocale)!
  );
  const comparisons = COMPARISONS.filter((c) => c.locales.includes(locale as AppLocale)).map(
    (c) => getComparison(c.slug, locale as AppLocale)!
  );

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
          {tNav("pricing")}
        </Link>
        <Link
          href="/sign-up"
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
        >
          {tNav("getStartedFree")}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-12">
        <div className="mb-14 flex flex-col gap-3">
          <h1 className="text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-[-0.025em] text-ink">
            {t("heading")}
          </h1>
          <p className="max-w-[56ch] text-[17px] leading-relaxed text-fg-2">
            {t("subtitle")}
          </p>
        </div>

        <Section heading={t("guidesHeading")}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {guides.map((c) => (
              <DocCard
                key={c.slug}
                href={`/${c.slug}`}
                heading={c.heading}
                description={c.metaDescription}
                cta={t("readCta")}
                timeToComplete={c.timeToComplete}
                stepCount={c.steps?.length}
              />
            ))}
          </div>
        </Section>

        <Section heading={t("comparisonsHeading")}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {comparisons.map((c) => (
              <DocCard
                key={c.slug}
                href={`/compare/${c.slug}`}
                heading={c.heading}
                description={c.metaDescription}
                cta={t("compareCta")}
              />
            ))}
          </div>
        </Section>
      </main>

      <SiteFooter />
    </div>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-14">
      <h2 className="mb-6 text-xs font-semibold uppercase tracking-[0.15em] text-fg-3">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function DocCard({
  href,
  heading,
  description,
  cta,
  timeToComplete,
  stepCount,
}: {
  href: string;
  heading: string;
  description: string;
  cta: string;
  timeToComplete?: string;
  stepCount?: number;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2.5 rounded-xl border border-hairline-cool bg-card p-6 shadow-card transition-all duration-150 hover:-translate-y-[2px] hover:border-hairline-strong hover:shadow-lg"
    >
      <h3 className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">
        {heading}
      </h3>
      <p className="line-clamp-3 text-sm leading-relaxed text-fg-2">
        {description}
      </p>
      {(timeToComplete != null || stepCount != null) && (
        <div className="flex flex-wrap gap-2">
          {stepCount != null && (
            <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent-ink">
              {stepCount} steps
            </span>
          )}
          {timeToComplete != null && (
            <span className="rounded-full bg-fg-3/10 px-2.5 py-0.5 text-[11px] font-medium text-fg-3">
              {timeToComplete}
            </span>
          )}
        </div>
      )}
      <span className="mt-auto text-sm font-medium text-accent-ink transition-colors group-hover:text-ink">
        {cta} <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}
