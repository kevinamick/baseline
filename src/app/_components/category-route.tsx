import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import { defaultOpenGraph, defaultTwitter, softwareApplicationSchema } from "@/lib/seo";
import { getCategory, CATEGORIES } from "@/lib/marketing/categories";
import { BrandMark } from "@/app/_components/brand-mark";
import { CategoryContent } from "@/app/_components/category-content";
import { JsonLd } from "@/app/_components/json-ld";
import { SiteFooter } from "@/app/_components/site-footer";

// Shared wiring for every `/{slug}` category lander (#278). The four routes are
// thin files that defer to these two helpers, so the template, metadata, locale-set
// guard, and SoftwareApplication graph live in exactly one place — adding a category
// is a data change plus a one-line route file.
//
// Like the comparison pages, these render on demand: the root layout reads headers()
// for the per-request CSP nonce (forcing dynamic rendering), so each route sets
// `export const dynamic = "force-dynamic"` and skips generateStaticParams. ADR-0013's
// "en-only; /es|fr/{slug} and unknown slugs are uncrawlable" guarantee lives entirely
// in the notFound() guard below.

type CategoryParams = { locale: string };

/** Resolve the category for this request, or 404 outside its declared locale set. */
function resolveOrNotFound(slug: string, locale: string) {
  // Resolve into the request locale (#280): es/fr overlay their translation, en is
  // canonical. The guard below still gates on the declared locale set.
  const category = getCategory(slug, locale as AppLocale);
  // Guard (mirrored in metadata and the page): a marketing page exists only in its
  // declared locale set, so a request outside it must 404, never serve.
  if (!category || !category.locales.includes(locale as AppLocale)) {
    notFound();
  }
  return category;
}

/** Metadata for a category route — self-canonical, full hreflang cluster (#280). */
export async function categoryMetadata(
  slug: string,
  params: Promise<CategoryParams>
): Promise<Metadata> {
  const { locale } = await params;
  const category = resolveOrNotFound(slug, locale);

  const path = `/${category.slug}`;
  return {
    title: category.metaTitle,
    description: category.metaDescription,
    alternates: buildMarketingAlternates(locale, path, category.locales),
    // No og:image here — the colocated opengraph-image route supplies it.
    openGraph: defaultOpenGraph(
      locale,
      path,
      category.metaTitle,
      category.metaDescription
    ),
    twitter: defaultTwitter(category.metaTitle, category.metaDescription),
  };
}

/** The rendered category lander: brand nav, prose body, SoftwareApplication graph. */
export async function CategoryRoute({
  slug,
  params,
}: {
  slug: string;
  params: Promise<CategoryParams>;
}) {
  const { locale } = await params;
  const category = resolveOrNotFound(slug, locale);

  const t = await getTranslations("Nav");
  // Localized section headings (#280); the prose is already in `category`.
  const tCat = await getTranslations("Marketing.category");
  const labels = {
    explainerHeading: tCat("explainerHeading"),
    howHeading: tCat("howHeading"),
    stepsHeading: tCat("stepsHeading"),
    prereqHeading: tCat("prereqHeading"),
    startCta: tCat("startCta"),
    outcomesHeading: tCat("outcomesHeading"),
    faqHeading: tCat("faqHeading"),
    relatedHeading: tCat("relatedHeading"),
  };

  const relatedCategories = (category.relatedSlugs ?? [])
    .map((s) => CATEGORIES.find((c) => c.slug === s))
    .filter((c): c is (typeof CATEGORIES)[number] => c !== undefined)
    .map((c) => ({ slug: c.slug, heading: c.heading }));
  // Per-request CSP nonce (minted in proxy.ts) so the JSON-LD block is trusted under
  // the strict nonce policy — same source the root layout reads for the theme script.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      {/* Product structured data for rich results (#278), nonce'd like Organization. */}
      <JsonLd schema={softwareApplicationSchema()} nonce={nonce} />

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
        <CategoryContent category={category} labels={labels} relatedCategories={relatedCategories} />
      </main>

      <SiteFooter />
    </div>
  );
}
